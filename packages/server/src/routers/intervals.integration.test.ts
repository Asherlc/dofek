import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { activity, activityInterval } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import { intervalsRouter } from "./intervals.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(intervalsRouter);
const providerId = "planned-intervals-fixture";
const start = new Date("2026-06-15T15:00:00Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);

describe("intervals.plannedByActivity with real Postgres and ClickHouse", () => {
  const analyticsDatabase = `planned_intervals_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const canonicalId = randomUUID();
  const mergedMemberId = randomUUID();
  const conflictId = randomUUID();
  const conflictMemberId = randomUUID();
  const legacyId = randomUUID();
  let postgres: TestContext;
  let queryCount = 0;

  const store = {
    ...makeMockSensorStore(),
    query: vi.fn(
      async <TSchema extends z.ZodType>(
        schema: TSchema,
        query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> => {
        queryCount++;
        const result = await clickhouse.query({
          query: query.replaceAll("analytics.", `${analyticsDatabase}.`),
          query_params: params,
          format: "JSONEachRow",
        });
        return z.array(schema).parse(await result.json());
      },
    ),
  };

  function caller(userId = TEST_USER_ID) {
    return createCaller({ db: postgres.db, userId, timezone: "UTC", sensorStore: store });
  }

  async function insertActivity(id: string, groupId: string) {
    await postgres.db.insert(activity).values({
      id,
      groupId,
      userId: TEST_USER_ID,
      providerId,
      externalId: id,
      canonicalType: "cycling",
      providerType: "cycling",
      startedAt: start,
      endedAt: at(360),
    });
  }

  function lap(
    activityId: string,
    index: number,
    from: number,
    to: number,
    plan: Partial<typeof activityInterval.$inferInsert>,
  ) {
    return {
      activityId,
      intervalIndex: index,
      startedAt: at(from),
      endedAt: at(to),
      sourceKind: "provider_recorded" as const,
      sourceProvider: providerId,
      sourceActivityId: activityId,
      fitSource: "workout_step_lap" as const,
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: to - from,
      ...plan,
    };
  }

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await ensureProvider(postgres.db, providerId, "Planned intervals", undefined, TEST_USER_ID);
    await insertActivity(canonicalId, canonicalId);
    await insertActivity(mergedMemberId, canonicalId);
    await insertActivity(conflictId, conflictId);
    await insertActivity(conflictMemberId, conflictId);
    await insertActivity(legacyId, legacyId);
    await postgres.db.insert(activityInterval).values([
      // Two laps of one planned step on a merged member; the second is a shortened lap.
      lap(mergedMemberId, 0, 0, 180, { targetPowerMinWatts: 250, targetPowerMaxWatts: 265 }),
      lap(mergedMemberId, 1, 180, 314, {
        targetPowerMinWatts: 250,
        targetPowerMaxWatts: 265,
        recordedTimerDurationSeconds: 134,
      }),
      lap(conflictId, 0, 0, 180, { targetPowerWatts: 250 }),
      lap(conflictMemberId, 0, 0, 180, { targetPowerWatts: 250, plannedDurationSeconds: 120 }),
      {
        activityId: legacyId,
        intervalIndex: 0,
        startedAt: start,
        endedAt: at(180),
        sourceKind: "provider_recorded" as const,
        sourceProvider: providerId,
        sourceActivityId: legacyId,
        targetPowerWatts: 250,
      },
    ]);

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.deduped_activities (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'),
        source_providers Array(String), member_activity_ids Array(UUID),
        timezone Nullable(String), local_time_source String,
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.activity_sensor_sample (
        activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'),
        channel LowCardinality(String), scalar Nullable(Float64),
        provider_id Nullable(String), device_id Nullable(String),
        measurement_kind LowCardinality(String), refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, channel, recorded_at)`,
    });
    await clickhouse.insert({
      table: `${analyticsDatabase}.deduped_activities`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: canonicalId,
          user_id: TEST_USER_ID,
          started_at: "2026-06-15 15:00:00.000000",
          source_providers: [providerId],
          member_activity_ids: [canonicalId, mergedMemberId],
          timezone: null,
          local_time_source: "unknown",
          refresh_version: 1,
          is_deleted: 0,
        },
      ],
    });
    // Lap 0 is 250 W. The sample at second 180 (the shared boundary) belongs to lap 1, which
    // is otherwise a measured 0 W.
    const power = (second: number) => (second < 180 ? 250 : second === 180 ? 100 : 0);
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_sensor_sample`,
      format: "JSONEachRow",
      values: Array.from({ length: 314 }, (_, second) => ({
        activity_id: canonicalId,
        user_id: TEST_USER_ID,
        recorded_at: `2026-06-15 15:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000000`,
        channel: "power",
        scalar: power(second),
        provider_id: providerId,
        device_id: "head-unit",
        measurement_kind: "direct",
        refresh_version: 1,
        is_deleted: 0,
      })),
    });
  });

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase}` });
    await clickhouse.close();
    await postgres?.cleanup();
  });

  it.each([
    ["canonical", () => canonicalId],
    ["merged member", () => mergedMemberId],
  ])("serves the same two matched laps for the %s ID", async (_name, id) => {
    const rows = await caller().plannedByActivity({ activityId: id() });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      intervalIndex: 0,
      startOffsetSeconds: 0,
      endOffsetSeconds: 180,
      target: { kind: "range", minWatts: 250, maxWatts: 265 },
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: 180,
      timerDifferenceSeconds: 0,
      averagePowerWatts: 250,
      sourceMemberActivityIds: [mergedMemberId],
    });
    expect(rows[1]).toMatchObject({
      intervalIndex: 1,
      startOffsetSeconds: 180,
      endOffsetSeconds: 314,
      recordedTimerDurationSeconds: 134,
      timerDifferenceSeconds: -46,
      averagePowerWatts: 0.7,
    });
  });

  it("returns nothing for a user who cannot see the activity", async () => {
    expect(await caller(randomUUID()).plannedByActivity({ activityId: mergedMemberId })).toEqual(
      [],
    );
  });

  it("returns nothing when duplicate members have conflicting plans", async () => {
    expect(await caller().plannedByActivity({ activityId: conflictId })).toEqual([]);
  });

  it("reads no power for a visible activity without an eligible plan", async () => {
    const before = queryCount;

    expect(await caller().plannedByActivity({ activityId: legacyId })).toEqual([]);
    expect(queryCount).toBe(before);
  });
});
