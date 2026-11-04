import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import {
  coordinateAnalyticsDelivery,
  coordinateAnalyticsDeliveryGroup,
} from "./analytics-delivery.ts";
import {
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { type AnalyticsQueryOwner, withAnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { loadAnalyticsStreamState } from "./analytics-work-store.ts";
import type { AnalyticsEffect } from "./effect-journal.ts";
import { analyticsEffect, analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("grouped publication coordinator", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
    await context.clickhouse.command({
      query: `CREATE TABLE analytics.group_raw
      (id UUID,ingested_at DateTime64(9)) ENGINE=ReplacingMergeTree ORDER BY id`,
    });
  });
  afterAll(async () => {
    await context.cleanup();
  });

  function input() {
    const stream = { ...context.stream, epoch: randomUUID() };
    const positions = [1n, 3n, 7n].map((entry) => analyticsPosition(stream, entry));
    const effects = positions.map((position) => analyticsEffect(position, 0n, context.userId));
    const counts = { prepare: 0, apply: 0 };
    const timestamps: string[][] = [];
    const options = {
      positions,
      maximum: 500,
      assertActive: async () => {},
      prepare: async () => {
        counts.prepare++;
        return effects;
      },
      apply: async (
        owner: AnalyticsQueryOwner,
        _positions: readonly MetricStreamPosition[],
        effects: readonly AnalyticsEffect[],
        times: readonly string[],
      ) => {
        counts.apply++;
        timestamps.push([...times]);
        const current = await loadAnalyticsStreamState(context.database, stream);
        expect(current?.processed).toBeNull();
        expect(current?.pendingGroup?.memberCount).toBe(3);
        await owner.client.command({
          query: `INSERT INTO analytics.group_raw SELECT pair.1,parseDateTime64BestEffort(pair.2,9)
            FROM (SELECT arrayJoin(arrayZip({ids:Array(UUID)},{times:Array(String)})) AS pair)`,
          query_params: { ids: effects.map((effect) => effect.sourceId), times },
        });
      },
    };
    return { stream, positions, effects, counts, timestamps, options };
  }

  it("advancesOnlyAfterAllReceiptsAndDoesNotReapplyAProcessedSuffix", async () => {
    const fixture = input();
    await coordinateAnalyticsDeliveryGroup(context, fixture.options);
    const state = await loadAnalyticsStreamState(context.database, fixture.stream);
    expect(state?.processed).toEqual(fixture.positions.at(-1));
    expect(state?.completedGroup?.memberCount).toBe(3);
    await coordinateAnalyticsDeliveryGroup(context, {
      ...fixture.options,
      positions: fixture.positions.slice(1),
    });
    expect(fixture.counts).toEqual({ prepare: 1, apply: 1 });
  });

  it("replaysTheOriginalPreparedEffectsAndPerMessageTimesAfterKnownRawSuccessFailure", async () => {
    const fixture = input();
    let fail = true;
    const apply = fixture.options.apply;
    fixture.options.apply = async (...args) => {
      await apply(...args);
      if (fail) {
        fail = false;
        throw new Error("Fixture failure after fully consumed raw response");
      }
    };
    await expect(coordinateAnalyticsDeliveryGroup(context, fixture.options)).rejects.toThrow(
      /raw response/,
    );
    const pending = await loadAnalyticsStreamState(context.database, fixture.stream);
    expect(pending?.processed).toBeNull();
    expect(pending?.pendingGroup?.memberCount).toBe(3);
    await coordinateAnalyticsDeliveryGroup(context, fixture.options);
    expect(fixture.counts).toEqual({ prepare: 1, apply: 2 });
    expect(fixture.timestamps[1]).toEqual(fixture.timestamps[0]);
  });

  it("aCoveredSubsetCanVerifyTheCompletedMembershipBeforeRetiringItsOriginalIntent", async () => {
    const fixture = input();
    await coordinateAnalyticsDeliveryGroup(context, fixture.options);
    const intentId = analyticsDeliveryGroupIntentId(
      describeAnalyticsDeliveryGroup(fixture.positions, 500),
    );
    const failure = new Error("Fixture retained completed intent after a terminal failure");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId: "metric-stream-source", intentId },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    await coordinateAnalyticsDeliveryGroup(context, {
      ...fixture.options,
      positions: fixture.positions.slice(2),
    });
    const row = await context.database.execute<{ intent_id: string | null }>(sql`
      SELECT intent_id FROM fitness.analytics_query_owner WHERE resource_id='metric-stream-source'`);
    expect(row[0]?.intent_id).toBeNull();
    expect(fixture.counts).toEqual({ prepare: 1, apply: 1 });
  });

  it("aSingletonControlAfterGroupedRowsUsesTheSameOrderedFrontier", async () => {
    const fixture = input();
    await coordinateAnalyticsDeliveryGroup(context, fixture.options);
    const position = analyticsPosition(fixture.stream, 8n);
    await coordinateAnalyticsDelivery(context, {
      position,
      assertActive: async () => {},
      prepare: async function* () {},
      applyControl: async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
      },
      apply: async () => {},
      acknowledgeEffects: async () => {},
    });
    const state = await loadAnalyticsStreamState(context.database, fixture.stream);
    expect(state?.processed).toEqual(position);
    expect(state?.completedGroup?.memberCount).toBe(1);
  });
});
