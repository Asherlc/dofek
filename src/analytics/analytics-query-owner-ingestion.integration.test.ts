import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyticsDeliveryGroupIngestionTimes } from "./analytics-delivery-group.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { createAnalyticsTestContext } from "./test-helpers.ts";

describe("group ingestion timestamp reservation", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("theNextGroupStartsAfterEveryReservedSlotEvenWhenTheClockIsBehind", async () => {
    const resourceId = randomUUID();
    await context.database.execute(sql`INSERT INTO fitness.analytics_query_owner(resource_id,ingested_at)
      VALUES (${resourceId},'2099-01-01T00:00:00.000000Z')`);
    let last = "";
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        const times = analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, 500);
        expect(times[0]).toBe("2099-01-01T00:00:00.000001Z");
        last = times.at(-1) ?? "";
        await owner.reserveIngestionThrough(last);
      },
    );
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        expect(owner.ingestedAt).toBe("2099-01-01T00:00:00.000501Z");
        expect(owner.ingestedAt > last).toBe(true);
      },
    );
  });

  it("reservingTheSamePendingGroupIsIdempotentAcrossClientRestart", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    const failure = new Error("Fixture leaves the prepared group pending");
    let times: readonly string[] = [];
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          times = analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, 100);
          const last = times.at(-1);
          if (!last) throw new Error("Missing timestamp reservation");
          await owner.reserveIngestionThrough(last);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    const replacement = context.makeClient();
    try {
      await withAnalyticsQueryOwner(
        context.database,
        replacement,
        { resourceId, intentId },
        async (owner) => {
          const last = times.at(-1);
          if (!last) throw new Error("Missing original reservation");
          expect(owner.ingestedAt).toBe(last);
          await owner.reserveIngestionThrough(last);
          expect(analyticsDeliveryGroupIngestionTimes(times[0] ?? "", 100)).toEqual(times);
        },
      );
    } finally {
      await replacement.close?.();
    }
  });

  it("oneExplicitSlotPreservesTheExistingOwnerTimestamp", async () => {
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        expect(analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, 1)).toEqual([
          owner.ingestedAt,
        ]);
        await owner.reserveIngestionThrough(owner.ingestedAt);
        await expect(owner.reserveIngestionThrough("invalid")).rejects.toThrow(
          /timestamp|time|ingestion/i,
        );
      },
    );
  });
});
