import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { createAnalyticsTestContext } from "./test-helpers.ts";

describe("analytics query ownership", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
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
    await withAnalyticsReceiptQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId },
      async (owner) => {
        const result = await owner.client.query<{ value: number }>({
          query: "SELECT 1 AS value",
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ value: 1 }]);
      },
    );
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

  test("lateClickHouseInsertAfterLostPostgresSessionKeepsReplacementBlocked", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await context.clickhouse.command({
      query:
        "CREATE TABLE analytics.owner_late_insert(value UInt8) ENGINE=MergeTree ORDER BY tuple()",
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
                "INSERT INTO analytics.owner_late_insert SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1",
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
      query: "SELECT toString(count()) AS count FROM analytics.owner_late_insert",
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
  });
});
