import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { coordinateAnalyticsDelivery } from "./analytics-delivery.ts";
import {
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { databaseAtSessionBoundary } from "./analytics-query-owner-test-helpers.ts";
import { loadAnalyticsStreamState } from "./analytics-work-store.ts";
import { verifyAnalyticsDeliveryReceipt } from "./effect-journal.ts";
import { analyticsEffect, analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("exact cooperative delivery completion", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeEach(async () => {
    context = await createAnalyticsTestContext();
  });
  afterEach(async () => {
    await context?.cleanup();
  });

  function delivery(transport: "kafka" | "pulsar", nonempty = false) {
    const position =
      transport === "kafka"
        ? {
            ...context.stream,
            transport: "kafka" as const,
            partition: 0,
            offset: "9007199254740993",
          }
        : analyticsPosition(context.stream, 9007199254740993n);
    const counts = { prepare: 0, control: 0, apply: 0, acknowledge: 0 };
    const effect = analyticsEffect(
      analyticsPosition(context.stream, 9007199254740993n),
      0n,
      context.userId,
    );
    const input = {
      position,
      assertActive: async () => undefined,
      prepare: async function* () {
        counts.prepare++;
        yield nonempty
          ? [
              {
                ...effect,
                position,
                stream: { ...context.stream, transport, partition: position.partition },
                cursor: {
                  delivery:
                    position.transport === "kafka"
                      ? { offset: position.offset }
                      : position.delivery,
                  effectOrdinal: "0",
                },
              },
            ]
          : [];
      },
      applyControl: async () => {
        counts.control++;
      },
      apply: async () => {
        counts.apply++;
      },
      acknowledgeEffects: async () => {
        counts.acknowledge++;
      },
    };
    return { input, counts };
  }

  async function leaveCompletedIntent(input: Parameters<typeof coordinateAnalyticsDelivery>[1]) {
    await expect(
      coordinateAnalyticsDelivery(context, {
        ...input,
        assertActive: async () => {
          if ((await loadAnalyticsStreamState(context.database, input.position))?.processed)
            throw new Error("known post-frontier cooperative failure");
        },
      }),
    ).rejects.toThrow("known post-frontier cooperative failure");
    return (
      await context.database.execute(
        sql`SELECT owner_id,intent_id,query_id,ingested_at,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
      )
    )[0];
  }

  async function state() {
    return (
      await context.database.execute(
        sql`SELECT intent_id,ingested_at,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
      )
    )[0];
  }

  test("replayWithoutPendingIntentIsReadOnlyAndPreservesTimeAndFrontier", async () => {
    const { input, counts } = delivery("pulsar", true);
    await coordinateAnalyticsDelivery(context, input);
    const before = await state(),
      beforeCounts = { ...counts };
    const frontier = await loadAnalyticsStreamState(context.database, input.position);
    await coordinateAnalyticsDelivery(context, input);
    expect(await state()).toEqual(before);
    expect(counts).toEqual(beforeCounts);
    expect(await loadAnalyticsStreamState(context.database, input.position)).toEqual(frontier);
  });

  test.each(["epoch", "topic", "partition", "transport"] as const)(
    "historicalAReplayPreservesUnrelatedCanonicalB: %s",
    async (difference) => {
      const { input, counts } = delivery("kafka");
      await coordinateAnalyticsDelivery(context, input);
      const bPosition =
        difference === "transport"
          ? analyticsPosition(context.stream, 9007199254740994n)
          : {
              ...input.position,
              transport: "kafka" as const,
              offset: "9007199254740994",
              ...(difference === "epoch"
                ? { epoch: randomUUID() }
                : difference === "topic"
                  ? { topic: `other-${randomUUID()}` }
                  : { partition: 1 }),
            };
      const pendingDelivery = { ...input, position: bPosition };
      await expect(
        coordinateAnalyticsDelivery(context, {
          ...pendingDelivery,
          applyControl: async () => {
            throw new Error("B remains pending before commit");
          },
        }),
      ).rejects.toThrow("B remains pending before commit");
      const pending = await state(),
        before = { ...counts };
      expect(pending?.intent_id).toEqual(expect.any(String));
      await coordinateAnalyticsDelivery(context, input);
      expect(await state()).toEqual(pending);
      expect(counts).toEqual(before);
      await coordinateAnalyticsDelivery(context, pendingDelivery);
      expect(await state()).toMatchObject({
        intent_id: null,
        ingested_at: pending?.ingested_at,
        query_terminal: true,
        quiescent: true,
      });
    },
  );

  test.each([
    "intent_id",
    "owner_id",
    "resource_id",
    "query_id",
    "query_terminal",
    "quiescent",
  ] as const)("retirementRequiresExactActualRow: %s", async (column) => {
    const { input } = delivery("kafka");
    await leaveCompletedIntent(input);
    let reached = false;
    const value =
      column === "query_terminal" ? false : column === "quiescent" ? true : randomUUID();
    const database = databaseAtSessionBoundary(context.database, async (text, dispatch) => {
      if (/SET intent_id=NULL/.test(text)) {
        reached = true;
        await context.database.execute(
          sql`UPDATE fitness.analytics_query_owner SET ${sql.identifier(column)}=${value} WHERE resource_id='metric-stream-source'`,
        );
      }
      return dispatch();
    });
    await expect(coordinateAnalyticsDelivery({ ...context, database }, input)).rejects.toThrow(
      "retirement",
    );
    expect(reached).toBe(true);
    const rows = await context.database.execute(
      sql`SELECT ${sql.identifier(column)} AS changed FROM fitness.analytics_query_owner`,
    );
    expect(rows).toEqual([{ changed: value }]);
  });

  test.each([
    "before commit",
    "lost committed response",
    "malformed proof",
    "session lost",
    "session before retirement",
  ] as const)("retirementUncertaintyBlocksAllAdmission: %s", async (failure) => {
    const { input } = delivery("pulsar");
    const pending = await leaveCompletedIntent(input);
    let retired = false;
    const database = databaseAtSessionBoundary(
      context.database,
      async (text, dispatch, session, values) => {
        if (/SET intent_id=NULL/.test(text)) {
          if (failure === "before commit") throw new Error("retirement precommit failure");
          if (failure === "session before retirement") {
            const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
            await context.database.execute(
              sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
            );
            await lost;
          }
          if (failure === "malformed proof")
            return session.query(
              text.replace("RETURNING owner_id,", "RETURNING owner_id AS unexpected_owner,"),
              values,
            );
          const result = await dispatch();
          retired = true;
          if (failure === "session lost") {
            const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
            await context.database.execute(
              sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
            );
            await lost;
            return result;
          }
          throw new Error("retirement committed response lost");
        }
        return dispatch();
      },
    );
    await expect(coordinateAnalyticsDelivery({ ...context, database }, input)).rejects.toThrow(
      /retirement|session|connection/,
    );
    const result = await state();
    expect(result).toMatchObject({
      intent_id:
        failure === "before commit" || failure === "session before retirement"
          ? pending?.intent_id
          : null,
      quiescent: false,
      ingested_at: pending?.ingested_at,
    });
    if (failure === "lost committed response" || failure === "session lost")
      expect(retired).toBe(true);
    await expect(coordinateAnalyticsDelivery(context, input)).rejects.toThrow("verified recovery");
    for (const intentId of [String(pending?.intent_id), randomUUID()])
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId: "metric-stream-source", intentId },
          async () => undefined,
        ),
      ).rejects.toThrow("verified recovery");
  });

  test.each([
    "missing receipt",
    "missing discovery",
    "missing payload",
    "serialized identity",
    "final transport",
  ] as const)("failedFreshProofRetainsMatchingIntent: %s", async (failure) => {
    const { input } = delivery("pulsar", failure === "missing payload");
    const pending = await leaveCompletedIntent(input);
    if (failure === "missing receipt")
      await context.clickhouse.command({ query: "TRUNCATE TABLE analytics.delivery_receipt" });
    if (failure === "missing discovery")
      await context.clickhouse.command({ query: "TRUNCATE TABLE analytics.effect_receipt" });
    if (failure === "missing payload")
      await context.clickhouse.command({ query: "TRUNCATE TABLE analytics.effect_journal" });
    const replay =
      failure === "serialized identity"
        ? {
            ...input,
            position: {
              ...input.position,
              transport: "pulsar" as const,
              delivery: analyticsPosition(context.stream, 9007199254740993n).delivery,
              serializedMessageId: analyticsPosition(context.stream, 9007199254740994n)
                .serializedMessageId,
            },
          }
        : input;
    let activeChecks = 0;
    await expect(
      coordinateAnalyticsDelivery(context, {
        ...replay,
        assertActive: async () => {
          if (failure === "final transport" && ++activeChecks === 3)
            throw new Error("replay final transport failure");
        },
      }),
    ).rejects.toThrow();
    expect(await state()).toMatchObject({
      intent_id: pending?.intent_id,
      ingested_at: pending?.ingested_at,
      query_terminal: true,
      quiescent: true,
    });
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId: "metric-stream-source", intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("pending intent");
  });

  test("voidVerifierCannotRetireMatchingPendingIntent", async () => {
    expectTypeOf<ReturnType<Parameters<typeof withAnalyticsReceiptQueryOwner>[3]>>().toEqualTypeOf<
      Promise<{ completedIntentId: string }>
    >();
    const { input } = delivery("kafka");
    const pending = await leaveCompletedIntent(input);
    // Exercise an untyped caller at the runtime boundary without fabricating a
    // successful domain proof. The specialized API must reject this no-op.
    await expect(
      Reflect.apply(withAnalyticsReceiptQueryOwner, undefined, [
        context.database,
        context.clickhouse,
        { resourceId: "metric-stream-source" },
        async () => undefined,
      ]),
    ).rejects.toThrow();
    expect(await state()).toMatchObject({
      intent_id: pending?.intent_id,
      query_terminal: true,
      quiescent: true,
    });
  });

  test("freshFrontierProofCannotReuseOuterObservation", async () => {
    const { input, counts } = delivery("kafka");
    const pending = await leaveCompletedIntent(input),
      before = { ...counts };
    const database = databaseAtSessionBoundary(context.database, async (text, dispatch) => {
      if (text.startsWith("SELECT quiescent,intent_id"))
        await context.database.execute(
          sql`UPDATE fitness.analytics_stream_state SET processed=NULL,
            group_state=NULL,group_first_position=NULL,group_last_position=NULL,
            group_member_count=NULL,group_positions_digest=NULL,group_first_ingested_at=NULL`,
        );
      return dispatch();
    });
    await expect(coordinateAnalyticsDelivery({ ...context, database }, input)).rejects.toThrow(
      "frontier no longer covers",
    );
    expect(counts).toEqual(before);
    expect(await state()).toMatchObject({
      intent_id: pending?.intent_id,
      ingested_at: pending?.ingested_at,
      quiescent: true,
      query_terminal: true,
    });
    await verifyAnalyticsDeliveryReceipt(context.clickhouse, input.position);
    expect(
      (await loadAnalyticsStreamState(context.database, input.position))?.processed,
    ).toBeNull();
  });

  test("inFlightReceiptVerifierCannotRetireIntentOrRelease", async () => {
    const { input } = delivery("kafka");
    const pendingIntent = await leaveCompletedIntent(input);
    let request: Promise<{ error?: unknown }> | undefined;
    try {
      await expect(
        Reflect.apply(withAnalyticsReceiptQueryOwner, undefined, [
          context.database,
          context.clickhouse,
          { resourceId: "metric-stream-source" },
          async (owner: Parameters<Parameters<typeof withAnalyticsReceiptQueryOwner>[3]>[0]) => {
            request = owner.client
              .query({
                query: "SELECT sleepEachRow(0.1) FROM numbers(30)",
                format: "JSONEachRow",
              })
              .then(
                () => ({}),
                (error: unknown) => ({ error }),
              );
            await vi.waitFor(async () => {
              const rows = await context.database.execute<{ query_id: string }>(
                sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
              );
              const running = await context.clickhouse.query<{ count: string }>({
                query:
                  "SELECT toString(count()) AS count FROM system.processes WHERE query_id={id:String}",
                query_params: { id: rows[0]?.query_id ?? "" },
                format: "JSONEachRow",
              });
              expect(await running.json()).toEqual([{ count: "1" }]);
            });
          },
        ]),
      ).rejects.toThrow("before its request completed");
    } finally {
      expect(await request).toEqual({});
    }
    expect(await state()).toMatchObject({
      intent_id: pendingIntent?.intent_id,
      query_terminal: false,
      quiescent: false,
      ingested_at: pendingIntent?.ingested_at,
    });
    await expect(coordinateAnalyticsDelivery(context, input)).rejects.toThrow("verified recovery");
  });

  test.each([
    "registration lost",
    "completion lost",
    "session before proof",
    "definitive rejection",
  ] as const)("failedOwnedProofNeverRequestsRetirement: %s", async (failure) => {
    const { input } = delivery("kafka");
    const pending = await leaveCompletedIntent(input);
    let retirement = false,
      queryId: unknown;
    const database = databaseAtSessionBoundary(
      context.database,
      async (text, dispatch, session) => {
        if (/SET intent_id=NULL/.test(text)) retirement = true;
        const result = await dispatch();
        if (failure === "session before proof" && text.includes("SET owner_id=$2,backend_pid")) {
          const pid = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
          await context.database.execute(sql`SELECT pg_terminate_backend(${pid.rows[0]?.pid})`);
          await lost;
        }
        if (
          (failure === "registration lost" && /SET query_id=/.test(text)) ||
          (failure === "completion lost" && /SET query_terminal=true/.test(text))
        ) {
          queryId = (
            await context.database.execute(
              sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
            )
          )[0]?.query_id;
          throw new Error("owned proof response lost");
        }
        return result;
      },
    );
    const clickhouse =
      failure === "definitive rejection"
        ? {
            ...context.clickhouse,
            query: <T extends object>(options: Parameters<typeof context.clickhouse.query>[0]) =>
              context.clickhouse.query<T>({
                ...options,
                query: "SELECT throwIf(1,'receipt verification server rejection')",
              }),
          }
        : context.clickhouse;
    await expect(
      coordinateAnalyticsDelivery({ ...context, database, clickhouse }, input),
    ).rejects.toThrow();
    expect(retirement).toBe(false);
    expect(await state()).toMatchObject({
      intent_id: pending?.intent_id,
      quiescent: failure === "definitive rejection",
      ingested_at: pending?.ingested_at,
    });
    if (queryId)
      expect(
        (
          await context.database.execute(
            sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
          )
        )[0]?.query_id,
      ).toBe(queryId);
    if (failure !== "definitive rejection")
      await expect(coordinateAnalyticsDelivery(context, input)).rejects.toThrow(
        "verified recovery",
      );
    else await coordinateAnalyticsDelivery(context, input);
  });

  test.each(["kafka", "pulsar"] as const)(
    "knownPostFrontierFailureReplaysAThenAdmitsB: %s",
    async (transport) => {
      const { input, counts } = delivery(transport);
      await expect(
        coordinateAnalyticsDelivery(context, {
          ...input,
          assertActive: async () => {
            if ((await loadAnalyticsStreamState(context.database, input.position))?.processed)
              throw new Error("known post-frontier cooperative failure");
          },
        }),
      ).rejects.toThrow("known post-frontier cooperative failure");
      const pending = await context.database.execute(
        sql`SELECT intent_id,ingested_at,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
      );
      expect(pending[0]).toMatchObject({
        intent_id: expect.any(String),
        query_terminal: true,
        quiescent: true,
      });
      await verifyAnalyticsDeliveryReceipt(context.clickhouse, input.position);
      const before = { ...counts };
      await coordinateAnalyticsDelivery(context, input);
      expect(counts).toEqual(before);
      const completed = await context.database.execute(
        sql`SELECT intent_id,ingested_at,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
      );
      expect(completed).toEqual([{ ...pending[0], intent_id: null }]);
      const next =
        transport === "kafka"
          ? { ...input.position, transport: "kafka" as const, offset: "9007199254740994" }
          : analyticsPosition(context.stream, 9007199254740994n);
      await expect(
        coordinateAnalyticsDelivery(context, { ...input, position: next }),
      ).resolves.toBeUndefined();
    },
  );
});
