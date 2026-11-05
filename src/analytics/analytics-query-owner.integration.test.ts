import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { coordinateAnalyticsDelivery } from "./analytics-delivery.ts";
import {
  type AnalyticsReceiptQueryOwner,
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { databaseAtSessionBoundary } from "./analytics-query-owner-test-helpers.ts";
import { loadAnalyticsStreamState } from "./analytics-work-store.ts";
import { verifyAnalyticsDeliveryReceipt } from "./effect-journal.ts";
import { analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("analytics query ownership", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });
  test("publicationReservationAdvancesPastPersistedFutureMicroseconds", async () => {
    const resourceId = randomUUID();
    await context.database.execute(
      sql`INSERT INTO fitness.analytics_query_owner(resource_id,ingested_at) VALUES (${resourceId},'2099-01-01T00:00:00.123456Z')`,
    );
    const times: string[] = [];
    for (let index = 0; index < 2; index++)
      await withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async (owner) => {
          times.push(owner.ingestedAt);
        },
      );
    expect(times).toEqual(["2099-01-01T00:00:00.123457Z", "2099-01-01T00:00:00.123458Z"]);
  });

  test("terminalPageFailureReleasesIntentOnlyWithPositiveLastRequestHistory", async () => {
    const resourceId = randomUUID();
    const seen: string[] = [];
    const client = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        if (options.query_id) seen.push(options.query_id);
        try {
          return await context.clickhouse.command(options);
        } finally {
          // Fixture-only: create durable native evidence before owner finalization.
          if (options.query_id) await context.clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
        }
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        client,
        { resourceId, intentId: randomUUID(), releaseFailedPage: true },
        async (owner) => {
          await owner.client.command({
            query: "SELECT 1",
            clickhouse_settings: { log_queries: 0 },
          });
          await owner.client.command({
            query: "SELECT throwIf(1,'page terminal fixture')",
            clickhouse_settings: { log_queries: 1 },
          });
        },
      ),
    ).rejects.toThrow("page terminal fixture");
    expect(seen).toHaveLength(2);
    expect(
      await context.database.execute(
        sql`SELECT intent_id,quiescent,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      ),
    ).toEqual([{ intent_id: null, quiescent: true, query_terminal: true }]);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  test("unloggedLastPageRequestBlocksDifferentIntentEvenAfterTerminalResponse", async () => {
    const resourceId = randomUUID();
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID(), releaseFailedPage: true },
        async (owner) => {
          await owner.client.command({
            query: "SELECT 1",
            clickhouse_settings: { log_queries: 1 },
          });
          await owner.client.command({
            query: "SELECT throwIf(1,'unlogged terminal fixture')",
            clickhouse_settings: { log_queries: 0 },
          });
        },
      ),
    ).rejects.toThrow("unlogged terminal fixture");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  const atBoundary = (exchange: Parameters<typeof databaseAtSessionBoundary>[1]) =>
    databaseAtSessionBoundary(context.database, exchange);

  test.each([0, 1, 3])("serialRequestsUseNPlusOneExchanges: %s", async (count) => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    for (const mode of ["write", "receipt"] as const) {
      const exchanges: string[] = [],
        ids: string[] = [];
      const database = atBoundary(async (text, dispatch) => {
        if (/SET query_(id|terminal)=/.test(text)) exchanges.push(text);
        return dispatch();
      });
      const operation = async (owner: AnalyticsReceiptQueryOwner) => {
        for (let index = 0; index < count; index++) {
          const result = await owner.client.query<{ value: number }>({
            query: "SELECT 7 AS value",
            format: "JSONEachRow",
          });
          expect(await result.json()).toEqual([{ value: 7 }]);
          const rows = await context.database.execute<{
            query_id: string;
            query_terminal: boolean;
            quiescent: boolean;
          }>(
            sql`SELECT query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          );
          expect(rows[0]).toEqual({
            query_id: expect.any(String),
            query_terminal: false,
            quiescent: false,
          });
          ids.push(rows[0]?.query_id ?? "");
        }
      };
      if (mode === "write")
        await withAnalyticsQueryOwner(
          database,
          context.clickhouse,
          { resourceId, intentId },
          operation,
        );
      else
        await expect(
          withAnalyticsReceiptQueryOwner(
            database,
            context.clickhouse,
            { resourceId },
            async (owner) => {
              await operation(owner);
              throw new Error("receipt verification intentionally incomplete");
            },
          ),
        ).rejects.toThrow("receipt verification intentionally incomplete");
      expect(exchanges).toHaveLength(count === 0 ? 0 : count + 1);
      expect(new Set(ids).size).toBe(count);
      expect(
        await context.database.execute(
          sql`SELECT query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        ),
      ).toEqual([{ query_terminal: true, quiescent: true }]);
    }
  });

  test("threeRequestsUseFourActualRequestExchanges", async () => {
    let exchanges = 0;
    const database = atBoundary(async (text, dispatch) => {
      if (/SET query_(id|terminal)=/.test(text)) exchanges++;
      return dispatch();
    });
    await withAnalyticsQueryOwner(
      database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        for (let index = 0; index < 3; index++) await owner.client.command({ query: "SELECT 1" });
      },
    );
    expect(exchanges).toBe(4);
  });

  test("lostCommittedRegistrationResponseBlocksContinuationAndCallbackSuccess", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    const boundaryError = new Error("committed registration response lost");
    let firstQueryId: unknown;
    let fail = true;
    let dispatched = 0;
    const database = atBoundary(async (text, dispatch) => {
      const result = await dispatch();
      if (fail && /\bSET\s+query_id\s*=/i.test(text)) {
        fail = false;
        const rows = await context.database.execute(
          sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        );
        firstQueryId = rows[0]?.query_id;
        throw boundaryError;
      }
      return result;
    });
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    let caught: unknown;
    let continuation: unknown;
    await expect(
      withAnalyticsQueryOwner(database, clickhouse, { resourceId, intentId }, async (owner) => {
        try {
          await owner.client.command({ query: "SELECT 1" });
        } catch (error) {
          caught = error;
        }
        try {
          await owner.client.command({ query: "SELECT 2" });
        } catch (error) {
          continuation = error;
        }
        return "swallowed registration failure";
      }),
    ).rejects.toThrow("unknown request outcome");
    expect(caught).toBe(boundaryError);
    expect(continuation).toEqual(
      expect.objectContaining({ message: expect.stringContaining("unknown request outcome") }),
    );
    expect(dispatched).toBe(0);
    expect(firstQueryId).toEqual(expect.any(String));
    const state = await context.database.execute(
      sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(state).toEqual([
      { intent_id: intentId, query_id: firstQueryId, query_terminal: false, quiescent: false },
    ]);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test.each(["first", "successor"])(
    "registrationFailureIsLatchedBeforeAwait: %s",
    async (boundary) => {
      for (const committed of [false, true]) {
        const resourceId = randomUUID(),
          intentId = randomUUID();
        let registrations = 0,
          dispatched = 0;
        let predecessor: unknown = null,
          registered: unknown = null;
        const database = atBoundary(async (text, dispatch) => {
          if (/SET query_id=/.test(text) && ++registrations === (boundary === "first" ? 1 : 2)) {
            if (committed) {
              await dispatch();
              registered = (
                await context.database.execute(
                  sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
                )
              )[0]?.query_id;
            }
            throw new Error("registration response unavailable");
          }
          return dispatch();
        });
        const client = {
          ...context.clickhouse,
          command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
            dispatched++;
            return context.clickhouse.command(options);
          },
        };
        await expect(
          withAnalyticsQueryOwner(database, client, { resourceId, intentId }, async (owner) => {
            if (boundary === "successor") {
              await owner.client.command({ query: "SELECT 1" });
              predecessor = (
                await context.database.execute(
                  sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
                )
              )[0]?.query_id;
            }
            await expect(owner.client.command({ query: "SELECT 2" })).rejects.toThrow(
              "registration response unavailable",
            );
            await expect(owner.client.command({ query: "SELECT 3" })).rejects.toThrow(
              "unknown request outcome",
            );
          }),
        ).rejects.toThrow("unknown request outcome");
        expect(dispatched).toBe(boundary === "first" ? 0 : 1);
        const durable = (
          await context.database.execute(
            sql`SELECT query_id,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          )
        )[0];
        expect(durable).toEqual({
          query_id: committed ? registered : predecessor,
          query_terminal: !committed && boundary === "first",
        });
        if (committed) {
          expect(registered).toEqual(expect.any(String));
          expect(registered).not.toBe(predecessor);
        }
        expect(
          await context.database.execute(
            sql`SELECT intent_id,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          ),
        ).toEqual([{ intent_id: intentId, quiescent: false }]);
        for (const replay of [intentId, randomUUID()])
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: replay },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
      }
    },
  );

  test.each(["first", "successor"])(
    "malformedActualRegistrationProofBlocksDispatch: %s",
    async (boundary) => {
      const resourceId = randomUUID(),
        intentId = randomUUID();
      let registrations = 0,
        dispatched = 0;
      const database = atBoundary(async (text, dispatch, session, values) => {
        if (/SET query_id=/.test(text) && ++registrations === (boundary === "first" ? 1 : 2)) {
          // Execute the original registration with an unexpected real RETURNING
          // column; the database result is neither mocked nor reconstructed.
          return session.query(
            text.replace("RETURNING owner_id,", "RETURNING owner_id AS unexpected_owner,"),
            values,
          );
        }
        return dispatch();
      });
      const client = {
        ...context.clickhouse,
        command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
          dispatched++;
          return context.clickhouse.command(options);
        },
      };
      await expect(
        withAnalyticsQueryOwner(database, client, { resourceId, intentId }, async (owner) => {
          if (boundary === "successor") await owner.client.command({ query: "SELECT 1" });
          await expect(owner.client.command({ query: "SELECT 2" })).rejects.toThrow("registration");
          await expect(owner.client.command({ query: "SELECT 3" })).rejects.toThrow(
            "unknown request outcome",
          );
        }),
      ).rejects.toThrow("unknown request outcome");
      expect(dispatched).toBe(boundary === "first" ? 0 : 1);
      expect(
        await context.database.execute(
          sql`SELECT intent_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        ),
      ).toEqual([{ intent_id: intentId, query_terminal: false, quiescent: false }]);
    },
  );

  test.each(["successor", "final"])(
    "receiptRetainsExactAdmittedIntentAtDeferredBoundary: %s",
    async (boundary) => {
      const resourceId = randomUUID(),
        intentId = randomUUID(),
        changedIntent = randomUUID();
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async () => {
            throw new Error("leave pending");
          },
        ),
      ).rejects.toThrow("leave pending");
      await expect(
        withAnalyticsReceiptQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId },
          async (owner) => {
            await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
            await context.database.execute(
              sql`UPDATE fitness.analytics_query_owner SET intent_id=${changedIntent} WHERE resource_id=${resourceId}`,
            );
            if (boundary === "successor")
              await owner.client.query({ query: "SELECT 2", format: "JSONEachRow" });
            throw new Error("verification interrupted");
          },
        ),
      ).rejects.toThrow(boundary === "successor" ? "registration" : "verification interrupted");
      expect(
        await context.database.execute(
          sql`SELECT intent_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        ),
      ).toEqual([{ intent_id: changedIntent, query_terminal: false, quiescent: false }]);
    },
  );

  test.each(["first", "successor", "final"])(
    "exactRowMutationsBlockDispatchOrFinalSuccess: %s",
    async (boundary) => {
      for (const mutation of [
        "resource_id",
        "owner_id",
        "intent_id",
        "query_id",
        "query_terminal",
        "quiescent",
      ] as const) {
        const resourceId = randomUUID(),
          intentId = randomUUID();
        let dispatched = 0;
        const client = {
          ...context.clickhouse,
          command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
            dispatched++;
            return context.clickhouse.command(options);
          },
        };
        const mutate = async () => {
          const value =
            mutation === "query_terminal"
              ? boundary !== "first"
              : mutation === "quiescent"
                ? true
                : randomUUID();
          await context.database.execute(
            sql`UPDATE fitness.analytics_query_owner SET ${sql.identifier(mutation)}=${value} WHERE resource_id=${resourceId}`,
          );
        };
        await expect(
          withAnalyticsQueryOwner(
            context.database,
            client,
            { resourceId, intentId },
            async (owner) => {
              if (boundary !== "first") await owner.client.command({ query: "SELECT 1" });
              await mutate();
              if (boundary !== "final") await owner.client.command({ query: "SELECT 2" });
            },
          ),
        ).rejects.toThrow(boundary === "final" ? "completion" : "registration");
        expect(dispatched).toBe(boundary === "first" ? 0 : 1);
      }
    },
  );

  test.each(["success", "server rejection"])(
    "failedFinalProofNeverReleasesEvenAfterCommit: %s",
    async (response) => {
      for (const failure of ["lost", "zero row", "malformed"] as const) {
        const resourceId = randomUUID(),
          intentId = randomUUID();
        let completed = false;
        const database = atBoundary(async (text, dispatch, session, values) => {
          if (/SET query_terminal=true/.test(text)) {
            if (failure === "zero row")
              await context.database.execute(
                sql`UPDATE fitness.analytics_query_owner SET query_id=${randomUUID()} WHERE resource_id=${resourceId}`,
              );
            // A malformed real RETURNING row is obtained by renaming the column in
            // this real statement, never by fabricating a result object.
            if (failure === "malformed")
              return session.query(
                text.replace("RETURNING owner_id,", "RETURNING owner_id AS unexpected_owner,"),
                values,
              );
            const result = await dispatch();
            completed = true;
            if (failure === "lost") throw new Error("final proof response lost");
            return result;
          }
          return dispatch();
        });
        await expect(
          withAnalyticsQueryOwner(
            database,
            context.clickhouse,
            { resourceId, intentId },
            async (owner) => {
              await owner.client.command({
                query:
                  response === "success"
                    ? "SELECT 1"
                    : "SELECT throwIf(1,'final fixture rejection')",
              });
            },
          ),
        ).rejects.toThrow(
          response === "success" ? /completion|final proof/ : "final fixture rejection",
        );
        if (failure === "lost") expect(completed).toBe(true);
        expect(
          await context.database.execute(
            sql`SELECT intent_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          ),
        ).toEqual([
          { intent_id: intentId, query_terminal: failure !== "zero row", quiescent: false },
        ]);
        for (const replay of [intentId, randomUUID()])
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: replay },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
      }
    },
  );

  test("frontierCommitsBeforeFailedFinalFlushButOuterSuccessAndReceiptReplayRemainBlocked", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 1n);
    let observed = false;
    const database = atBoundary(async (text, dispatch) => {
      if (/SET query_terminal=true/.test(text)) {
        expect((await loadAnalyticsStreamState(context.database, position))?.processed).toEqual(
          position,
        );
        await verifyAnalyticsDeliveryReceipt(context.clickhouse, position);
        observed = true;
        await dispatch();
        throw new Error("frontier committed; final proof lost");
      }
      return dispatch();
    });
    const input = {
      position,
      assertActive: async () => undefined,
      prepare: async function* () {
        yield [];
      },
      applyControl: async () => undefined,
      apply: async () => undefined,
      acknowledgeEffects: async () => undefined,
    };
    await expect(
      coordinateAnalyticsDelivery({ database, clickhouse: context.clickhouse }, input),
    ).rejects.toThrow("final proof lost");
    expect(observed).toBe(true);
    expect((await loadAnalyticsStreamState(context.database, position))?.processed).toEqual(
      position,
    );
    expect(
      await context.database.execute(
        sql`SELECT intent_id IS NOT NULL AS pending,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`,
      ),
    ).toEqual([{ pending: true, query_terminal: true, quiescent: false }]);
    await expect(
      coordinateAnalyticsDelivery(
        { database: context.database, clickhouse: context.clickhouse },
        input,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test.each(["consumed response", "successor registered"])(
    "executorLossRequiresExternalProof: %s",
    async (boundary) => {
      const resourceId = randomUUID(),
        intentId = randomUUID();
      let registrations = 0,
        dispatched = 0,
        firstId: unknown;
      const database = atBoundary(async (text, dispatch, session) => {
        const result = await dispatch();
        if (
          /SET query_id=/.test(text) &&
          ++registrations === 2 &&
          boundary === "successor registered"
        ) {
          const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
          await context.database.execute(
            sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          );
          await lost;
        }
        return result;
      });
      const client = {
        ...context.clickhouse,
        command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
          dispatched++;
          return context.clickhouse.command(options);
        },
      };
      await expect(
        withAnalyticsQueryOwner(database, client, { resourceId, intentId }, async (owner) => {
          await owner.client.command({ query: "SELECT 1" });
          const rows = await context.database.execute(
            sql`SELECT query_id,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          );
          firstId = rows[0]?.query_id;
          expect(rows[0]?.query_terminal).toBe(false);
          if (boundary === "consumed response") {
            await context.database.execute(
              sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
            );
            await vi.waitFor(async () => {
              await expect(owner.assertActive()).rejects.toThrow();
            });
          } else await owner.client.command({ query: "SELECT 2" });
        }),
      ).rejects.toThrow();
      expect(dispatched).toBe(1);
      const rows = await context.database.execute(
        sql`SELECT query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(rows[0]).toEqual({
        query_id: expect.any(String),
        query_terminal: false,
        quiescent: false,
      });
      if (boundary === "consumed response") expect(rows[0]?.query_id).toBe(firstId);
      else expect(rows[0]?.query_id).not.toBe(firstId);
      for (const replay of [intentId, randomUUID()])
        await expect(
          withAnalyticsQueryOwner(
            context.database,
            context.clickhouse,
            { resourceId, intentId: replay },
            async () => undefined,
          ),
        ).rejects.toThrow("verified recovery");
    },
  );

  test.each(["consumed response", "successor registered"])(
    "killedExecutorCannotRecoverItsLocalTerminalEvidence: %s",
    async (boundary) => {
      const resourceId = randomUUID(),
        intentId = randomUUID();
      const child = fork(
        new URL("./analytics-query-owner-executor-test-helpers.ts", import.meta.url),
        [],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      const reached = new Promise<string>((resolve, reject) => {
        child.once("message", (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "queryId" in message &&
            typeof message.queryId === "string"
          )
            resolve(message.queryId);
          else reject(new Error("Executor fixture returned an invalid boundary"));
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Executor exited before boundary: ${stderr}`)));
      });
      child.send({ connectionString: context.connectionString, resourceId, intentId, boundary });
      try {
        const queryId = await reached;
        expect(
          await context.database.execute(
            sql`SELECT query_id,query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          ),
        ).toEqual([
          { query_id: queryId, query_terminal: false, quiescent: false, intent_id: intentId },
        ]);
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
        for (const replay of [intentId, randomUUID()])
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: replay },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
        expect(
          await context.database.execute(
            sql`SELECT query_id,query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          ),
        ).toEqual([
          { query_id: queryId, query_terminal: false, quiescent: false, intent_id: intentId },
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    },
  );

  test("closingNeverReopensAdmissionAndUnawaitedRequestCannotRelease", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    let escaped: AnalyticsReceiptQueryOwner | undefined;
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        escaped = owner;
        await owner.client.command({ query: "SELECT 1" });
      },
    );
    if (!escaped) throw new Error("Missing escaped owner");
    await expect(
      escaped.client.query({ query: "SELECT 2", format: "JSONEachRow" }),
    ).rejects.toThrow("closed");
    const unawaitedResource = randomUUID();
    let pending: Promise<unknown> | undefined;
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId: unawaitedResource, intentId },
        async (owner) => {
          pending = owner.client.command({
            query: "SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1",
          });
          await vi.waitFor(async () => {
            const rows = await context.database.execute<{ query_id: string }>(
              sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${unawaitedResource}`,
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
      ),
    ).rejects.toThrow("before its request completed");
    await pending;
    expect(
      await context.database.execute(
        sql`SELECT query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${unawaitedResource}`,
      ),
    ).toEqual([{ query_terminal: false, quiescent: false, intent_id: intentId }]);
  });

  test("finalFlushKeepsEscapedCallbacksClosed", async () => {
    let escaped: AnalyticsReceiptQueryOwner | undefined;
    let flushing = false;
    const database = atBoundary(async (text, dispatch) => {
      if (/SET query_terminal=true/.test(text)) {
        flushing = true;
        if (!escaped) throw new Error("Missing owner at final flush");
        await expect(
          escaped.client.query({ query: "SELECT 2", format: "JSONEachRow" }),
        ).rejects.toThrow("closed");
        await expect(escaped.assertActive()).rejects.toThrow("closed");
      }
      return dispatch();
    });
    await withAnalyticsQueryOwner(
      database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        escaped = owner;
        await owner.client.command({ query: "SELECT 1" });
      },
    );
    expect(flushing).toBe(true);
  });

  test("zeroRequestFailuresRetainIntentWithoutSyntheticRequestProof", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    let requestExchanges = 0;
    const database = atBoundary(async (text, dispatch) => {
      if (/SET query_(id|terminal)=/.test(text)) requestExchanges++;
      return dispatch();
    });
    let ingestedAt = "";
    await expect(
      withAnalyticsQueryOwner(
        database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          ingestedAt = owner.ingestedAt;
          throw new Error("no-query write failure");
        },
      ),
    ).rejects.toThrow("no-query write failure");
    await expect(
      withAnalyticsReceiptQueryOwner(database, context.clickhouse, { resourceId }, async () => {
        throw new Error("no-query receipt failure");
      }),
    ).rejects.toThrow("no-query receipt failure");
    expect(requestExchanges).toBe(0);
    expect(
      await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      ),
    ).toEqual([{ intent_id: intentId, query_id: null, query_terminal: true, quiescent: true }]);
    await withAnalyticsQueryOwner(
      database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(ingestedAt);
      },
    );
  });

  test.each([false, true])(
    "caughtDefinitiveErrorFinalizesWithoutAnotherRequest: %s",
    async (applicationFailure) => {
      const resourceId = randomUUID(),
        intentId = randomUUID();
      const result = withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await expect(
            owner.client.command({ query: "SELECT throwIf(1,'caught final rejection')" }),
          ).rejects.toThrow("caught final rejection");
          expect(
            await context.database.execute(
              sql`SELECT query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
            ),
          ).toEqual([{ query_terminal: false, quiescent: false }]);
          if (applicationFailure) throw new Error("application failure");
          return 7;
        },
      );
      if (applicationFailure) await expect(result).rejects.toThrow("application failure");
      else await expect(result).resolves.toBe(7);
      expect(
        await context.database.execute(
          sql`SELECT query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        ),
      ).toEqual([
        { query_terminal: true, quiescent: true, intent_id: applicationFailure ? intentId : null },
      ]);
    },
  );

  test.each(["write", "receipt"])(
    "registrationRejectsChangedAdmittedIntentFor%sOwnerBeforeDispatch",
    async (mode) => {
      const resourceId = randomUUID(),
        intentId = randomUUID(),
        changedIntent = randomUUID();
      if (mode === "receipt")
        await expect(
          withAnalyticsQueryOwner(
            context.database,
            context.clickhouse,
            { resourceId, intentId },
            async () => {
              throw new Error("leave known pending intent");
            },
          ),
        ).rejects.toThrow("leave known pending intent");
      let dispatched = 0;
      const clickhouse = {
        ...context.clickhouse,
        query: <T extends object>(options: Parameters<typeof context.clickhouse.query>[0]) => {
          dispatched++;
          return context.clickhouse.query<T>(options);
        },
      };
      const operation = async (owner: AnalyticsReceiptQueryOwner) => {
        await context.database.execute(
          sql`UPDATE fitness.analytics_query_owner SET intent_id=${changedIntent} WHERE resource_id=${resourceId}`,
        );
        await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
        throw new Error("verification unexpectedly reached callback end");
      };
      const result =
        mode === "write"
          ? withAnalyticsQueryOwner(
              context.database,
              clickhouse,
              { resourceId, intentId },
              operation,
            )
          : withAnalyticsReceiptQueryOwner(context.database, clickhouse, { resourceId }, operation);
      await expect(result).rejects.toThrow("registration");
      expect(dispatched).toBe(0);
      const state = await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(state).toEqual([
        { intent_id: changedIntent, query_id: null, query_terminal: true, quiescent: false },
      ]);
    },
  );

  test.each(["success", "server rejection"])(
    "terminalUpdateRequiresExactIntentAfter%s",
    async (response) => {
      const resourceId = randomUUID(),
        intentId = randomUUID(),
        changedIntent = randomUUID();
      let firstQueryId: unknown;
      const database = atBoundary(async (text, dispatch) => {
        if (/\bSET\s+query_terminal\s*=\s*true\b/i.test(text)) {
          const rows = await context.database.execute(
            sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          );
          firstQueryId = rows[0]?.query_id;
          await context.database.execute(
            sql`UPDATE fitness.analytics_query_owner SET intent_id=${changedIntent} WHERE resource_id=${resourceId}`,
          );
        }
        return dispatch();
      });
      await expect(
        withAnalyticsQueryOwner(
          database,
          context.clickhouse,
          { resourceId, intentId },
          async (owner) => {
            await owner.client.command({
              query:
                response === "success" ? "SELECT 1" : "SELECT throwIf(1,'terminal proof boundary')",
            });
          },
        ),
      ).rejects.toThrow(response === "success" ? "completion" : "terminal proof boundary");
      expect(firstQueryId).toEqual(expect.any(String));
      const state = await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(state).toEqual([
        {
          intent_id: changedIntent,
          query_id: firstQueryId,
          query_terminal: false,
          quiescent: false,
        },
      ]);
    },
  );

  test("registrationCannotReplaceAnUnterminatedPredecessorQuery", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID(),
      predecessor = randomUUID();
    let dispatched = 0;
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await context.database.execute(
            sql`UPDATE fitness.analytics_query_owner SET query_id=${predecessor},query_terminal=false WHERE resource_id=${resourceId}`,
          );
          await owner.client.command({ query: "SELECT 1" });
        },
      ),
    ).rejects.toThrow("registration");
    expect(dispatched).toBe(0);
    const rows = await context.database.execute(
      sql`SELECT query_id,query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows).toEqual([
      { query_id: predecessor, query_terminal: false, quiescent: false, intent_id: intentId },
    ]);
  });

  test("lostSessionAfterCommittedRegistrationPreventsClickHouseDispatch", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    let fail = true;
    let dispatched = 0;
    const database = atBoundary(async (text, dispatch, session) => {
      const result = await dispatch();
      if (fail && /\bSET\s+query_id\s*=/i.test(text)) {
        fail = false;
        const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
        await context.database.execute(
          sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        );
        await lost;
      }
      return result;
    });
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    await expect(
      withAnalyticsQueryOwner(database, clickhouse, { resourceId, intentId }, async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
      }),
    ).rejects.toThrow("lost its session");
    expect(dispatched).toBe(0);
    const rows = await context.database.execute(
      sql`SELECT query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows).toEqual([{ query_terminal: false, quiescent: false, intent_id: intentId }]);
  });

  test("serialAdmissionRejectsOverlappingRequestsWithoutPoisoningSuccessfulOwner", async () => {
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        const first = owner.client.command({ query: "SELECT 1" });
        await expect(owner.client.command({ query: "SELECT 2" })).rejects.toThrow(
          "serial requests",
        );
        await first;
      },
    );
  });

  test("cooperativeFailureKeepsPendingIntentAndFreezesIngestionTime", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT 1" });
          throw new Error("failure after known terminal raw insert");
        },
      ),
    ).rejects.toThrow("failure after known terminal raw insert");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("pending intent");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
        await owner.assertActive();
      },
    );
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        expect(owner.ingestedAt > originalTimestamp).toBe(true);
      },
    );
  });

  test("liveAndHistoryOwnersHandOffCooperativelyWithoutFailing", async () => {
    const resourceId = randomUUID();
    let releaseFirst: () => void = () => {
      throw new Error("Owner not started");
    };
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => {
      throw new Error("Barrier not initialized");
    };
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const order: string[] = [];
    const first = withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async () => {
        order.push("live");
        firstEntered();
        await release;
      },
    );
    await entered;
    const second = withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        order.push("history");
        await owner.client.command({ query: "SELECT 1" });
      },
    );
    // Attach immediately so the old try-lock implementation reports an assertion
    // failure rather than an unhandled rejected promise while observing the waiter.
    const secondOutcome = second.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(async () => {
        const waiting = await context.database.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND wait_event='advisory'
              AND query LIKE '%pg_advisory_lock%') AS waiting`);
        expect(waiting[0]?.waiting).toBe(true);
        expect(order).toEqual(["live"]);
      });
    } finally {
      releaseFirst();
      await first;
    }
    expect(await secondOutcome).toBeNull();
    expect(order).toEqual(["live", "history"]);
  });

  test("lostPostgresLockDoesNotPermitAnotherPublication", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await context.database.execute(sql`
          SELECT pg_terminate_backend(backend_pid)
          FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
          await expect(owner.client.command({ query: "SELECT 1" })).rejects.toThrow();
        },
      ),
    ).rejects.toThrow();
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test("unknownClickHouseRequestOutcomeBlocksEvenSameIntent", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    // The transport loses its response after the real server completed this request.
    const disconnected = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        await context.clickhouse.command(options);
        throw new Error("response transport disconnected");
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        disconnected,
        { resourceId, intentId },
        async (owner) => {
          await owner.client.command({ query: "SELECT 1" });
        },
      ),
    ).rejects.toThrow("response transport disconnected");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test.each(["second request", "callback return", "successor"])(
    "caughtUnknownOutcomeBlocks%sAndRetainsFirstQueryWhileLateInsertCompletes",
    async (continuation) => {
      const resourceId = randomUUID();
      const intentId = randomUUID();
      const table = `analytics.owner_unknown_${randomUUID().replaceAll("-", "")}`;
      await context.clickhouse.command({
        query: `CREATE TABLE ${table}(value UInt8) ENGINE=MergeTree ORDER BY tuple()`,
      });
      const transportError = new Error("unknown client response while insert still runs");
      const dispatched: string[] = [];
      let lateResult: Promise<{ error?: unknown }> | undefined;
      let firstQueryId = "";
      let caught: unknown;
      let secondCaught: unknown;
      let predecessorId: string | undefined;
      const disconnected = {
        ...context.clickhouse,
        command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
          if (!options.query_id) throw new Error("Fixture requires owned query ID");
          dispatched.push(options.query_id);
          if (!options.query.startsWith(`INSERT INTO ${table}`))
            return context.clickhouse.command(options);
          firstQueryId = options.query_id;
          lateResult = context.clickhouse.command(options).then(
            () => ({}),
            (error: unknown) => ({ error }),
          );
          // Observe the actual server request before losing the client boundary.
          await vi.waitFor(async () => {
            const running = await context.clickhouse.query<{ count: string }>({
              query:
                "SELECT toString(count()) AS count FROM system.processes WHERE query_id={id:String}",
              query_params: { id: firstQueryId },
              format: "JSONEachRow",
            });
            expect(await running.json()).toEqual([{ count: "1" }]);
          });
          throw transportError;
        },
      };
      try {
        const outcome = await withAnalyticsQueryOwner(
          context.database,
          disconnected,
          { resourceId, intentId },
          async (owner) => {
            if (continuation === "successor") {
              await owner.client.command({ query: "SELECT 1" });
              predecessorId = dispatched[0];
            }
            try {
              await owner.client.command({
                query: `INSERT INTO ${table} SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1`,
              });
            } catch (error) {
              caught = error;
            }
            if (continuation !== "callback return") {
              try {
                await owner.client.command({ query: "SELECT 1" });
              } catch (error) {
                secondCaught = error;
              }
            }
            return "swallowed failure";
          },
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        expect(caught).toBe(transportError);
        if (continuation !== "callback return")
          expect(secondCaught).toEqual(
            expect.objectContaining({
              message: expect.stringContaining("unknown request outcome"),
            }),
          );
        expect(dispatched).toEqual(predecessorId ? [predecessorId, firstQueryId] : [firstQueryId]);
        expect(outcome).toEqual({
          error: expect.objectContaining({
            message: expect.stringContaining("unknown request outcome"),
          }),
        });
        const state = await context.database.execute(sql`
          SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner
          WHERE resource_id=${resourceId}`);
        expect(state).toEqual([
          { intent_id: intentId, query_id: firstQueryId, query_terminal: false, quiescent: false },
        ]);
        for (const replayIntent of [intentId, randomUUID()])
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: replayIntent },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
      } finally {
        // The deliberately disconnected client does not own the server lifetime.
        // Always await the real request before the suite may drop its database.
        expect(lateResult).toBeDefined();
        expect(await lateResult).toEqual({});
      }
      const rows = await context.clickhouse.query<{ count: string }>({
        query: `SELECT toString(count()) AS count FROM ${table}`,
        format: "JSONEachRow",
      });
      expect(await rows.json()).toEqual([{ count: "30" }]);
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async () => undefined,
        ),
      ).rejects.toThrow("verified recovery");
    },
  );

  test("terminalServerRejectionAllowsOriginalIntentReplay", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT throwIf(1, 'terminal fixture rejection')" });
        },
      ),
    ).rejects.toThrow("terminal fixture rejection");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
        await owner.client.command({ query: "SELECT 1" });
      },
    );
  });

  test("caughtDefinitiveServerRejectionStillAllowsNextOwnedRequest", async () => {
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        await expect(
          owner.client.command({ query: "SELECT throwIf(1, 'caught terminal rejection')" }),
        ).rejects.toThrow("caught terminal rejection");
        const result = await owner.client.query<{ value: number }>({
          query: "SELECT 7 AS value",
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ value: 7 }]);
      },
    );
  });

  test("receiptVerificationRetainsPendingIntentAndCannotMutate", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await context.clickhouse.command({
      query: "CREATE TABLE analytics.owner_readonly(value UInt8) ENGINE=MergeTree ORDER BY tuple()",
    });
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT 1" });
          throw new Error("known boundary failure");
        },
      ),
    ).rejects.toThrow("known boundary failure");
    await expect(
      withAnalyticsReceiptQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId },
        async (owner) => {
          await owner.client.query({
            query: "INSERT INTO analytics.owner_readonly VALUES (1)",
            format: "JSONEachRow",
            clickhouse_settings: { readonly: 0 },
          });
          throw new Error("read-only mutation unexpectedly succeeded");
        },
      ),
    ).rejects.toThrow(/readonly|read.only/i);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("pending intent");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
      },
    );
    const rows = await context.clickhouse.query<{ count: string }>({
      query: "SELECT toString(count()) AS count FROM analytics.owner_readonly",
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ count: "0" }]);
  });

  test.each(["command", "input"])(
    "lateClickHouseInsertAfterLostPostgresSessionKeepsReplacementBlocked: %s",
    async (mode) => {
      const resourceId = randomUUID();
      const intentId = randomUUID();
      await context.clickhouse.command({
        query: `CREATE TABLE analytics.owner_late_insert_${mode}(value UInt8) ENGINE=MergeTree ORDER BY tuple()`,
      });
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async (owner) => {
            const finished = expect(
              owner.client.command({
                query:
                  mode === "input"
                    ? `INSERT INTO analytics.owner_late_insert_${mode} SELECT sleepEachRow(0.1)+toUInt8(n*0) FROM input('n UInt64') SETTINGS max_block_size=1 FORMAT JSONEachRow`
                    : `INSERT INTO analytics.owner_late_insert_${mode} SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1`,
                ...(mode === "input"
                  ? {
                      values: Readable.from([
                        Array.from({ length: 30 }, (_, n) => JSON.stringify({ n })).join("\n") +
                          "\n",
                      ]),
                    }
                  : {}),
              }),
            ).rejects.toThrow();
            await vi.waitFor(async () => {
              const rows = await context.database.execute<{ query_id: string | null }>(sql`
            SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
              const queryId = rows[0]?.query_id;
              expect(queryId).toBeTruthy();
              const running = await context.clickhouse.query<{ count: string }>({
                query:
                  "SELECT toString(count()) AS count FROM system.processes WHERE query_id={id:String}",
                query_params: { id: queryId },
                format: "JSONEachRow",
              });
              expect(await running.json()).toEqual([{ count: "1" }]);
            });
            await context.database.execute(sql`
          SELECT pg_terminate_backend(backend_pid)
          FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
            await expect(
              withAnalyticsQueryOwner(
                context.database,
                context.clickhouse,
                { resourceId, intentId: randomUUID() },
                async () => undefined,
              ),
            ).rejects.toThrow("verified recovery");
            await finished;
          },
        ),
      ).rejects.toThrow();
      const inserted = await context.clickhouse.query<{ count: string }>({
        query: `SELECT toString(count()) AS count FROM analytics.owner_late_insert_${mode}`,
        format: "JSONEachRow",
      });
      expect(await inserted.json()).toEqual([{ count: "30" }]);
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async () => undefined,
        ),
      ).rejects.toThrow("verified recovery");
    },
  );
});
