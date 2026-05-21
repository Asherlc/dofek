import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

function dateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/**
 * Integration test verifying that overlapping activities are deduplicated
 * before ClickHouse activity analytics consume them.
 */
describe("Activity summary deduplication", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  let canonicalActivityId: string;
  let memberActivityId: string;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile with max_hr (required for TRIMP calculation)
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50
          WHERE id = ${TEST_USER_ID}`,
    );

    // Insert two providers with different priorities
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert overlapping cycling workouts from BOTH providers at two time points
    // spanning different ISO weeks. The ramp rate endpoint needs 2+ weeks of data
    // to produce week-over-week deltas, so a single activity isn't enough.
    // The v_activity dedup view should merge each pair into one canonical activity.
    const durationSec = 1800; // 30 minutes
    const activityOffsetsDaysAgo = [3, 14]; // two different ISO weeks

    for (const daysAgo of activityOffsetsDaysAgo) {
      const wahooResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'wahoo', ${TEST_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second',
              'Morning Ride'
            ) RETURNING id`,
      );
      const wahooActivityId = wahooResult[0]?.id;

      const appleResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'apple_health', ${TEST_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + INTERVAL '10 seconds',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second' - INTERVAL '10 seconds',
              'Morning Ride'
            ) RETURNING id`,
      );
      const appleActivityId = appleResult[0]?.id;

      if (!wahooActivityId || !appleActivityId) {
        throw new Error("Expected overlapping activity insert to return ids");
      }
    }

    const aliasRows = await testCtx.db.execute<{ id: string; member_activity_ids: string[] }>(
      sql`SELECT id, member_activity_ids::text[] AS member_activity_ids
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND cardinality(member_activity_ids) > 1
          ORDER BY started_at DESC
          LIMIT 1`,
    );
    const aliasRow = aliasRows[0];
    const nonCanonicalMemberId = aliasRow?.member_activity_ids.find(
      (activityId) => activityId !== aliasRow.id,
    );
    if (!aliasRow || !nonCanonicalMemberId) {
      throw new Error("Expected overlapping activity aliases in fitness.v_activity");
    }
    canonicalActivityId = aliasRow.id;
    memberActivityId = nonCanonicalMemberId;

    const previousLoadDate = dateDaysAgo(14);
    const recentLoadDate = dateDaysAgo(7);

    const queryMock: ActivitySensorStore["query"] = async (_schema, queryText) => {
      if (queryText.includes("SELECT date, resting_hr")) {
        return [{ date: previousLoadDate, resting_hr: 50 }];
      }
      return [
        { day: previousLoadDate, trimp: 50 },
        { day: recentLoadDate, trimp: 52 },
      ];
    };

    sensorStore = {
      ...makeMockSensorStore(),
      query: vi.fn(queryMock),
      getActivitySummaries: vi.fn().mockResolvedValue([
        {
          activity_id: memberActivityId,
          avg_hr: 144,
          max_hr: 171,
          avg_power: 212,
          max_power: 390,
          avg_speed: 8.1,
          max_speed: 12.4,
          avg_cadence: 86,
          total_distance: 31_000,
          elevation_gain_m: 440,
          elevation_loss_m: 430,
          sample_count: 1800,
        },
      ]),
      getStream: vi.fn().mockResolvedValue([
        {
          recorded_at: "2026-04-20T15:00:00.000Z",
          heart_rate: 144,
          power: 212,
          speed: 8.1,
          cadence: 86,
          altitude: 120,
          lat: 47.6,
          lng: -122.3,
        },
      ]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([{ zone: 2, seconds: 120 }]),
    };

    const app = createApp(testCtx.db, sensorStore);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  it("v_activity is a regular view so activity inserts are visible without refresh", async () => {
    const result = await testCtx.db.execute<{ exists: boolean }>(
      sql`SELECT EXISTS (
            SELECT 1
            FROM information_schema.views
            WHERE table_schema = 'fitness'
              AND table_name = 'v_activity'
          ) AS "exists"`,
    );
    expect(result[0]?.exists).toBe(true);

    const inserted = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'wahoo', ${TEST_USER_ID}, 'cycling',
            CURRENT_TIMESTAMP + INTERVAL '1 day',
            CURRENT_TIMESTAMP + INTERVAL '1 day' + INTERVAL '30 minutes',
            'Fresh Ride'
          )
          RETURNING id`,
    );
    const activityId = inserted[0]?.id;

    if (!activityId) {
      throw new Error("Expected fresh activity insert to return id");
    }

    try {
      const viewResult = await testCtx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
            FROM fitness.v_activity
            WHERE id = ${activityId}`,
      );
      expect(Number(viewResult[0]?.count)).toBe(1);
    } finally {
      await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ${activityId}`);
    }
  });

  it("v_activity contains only one canonical row per overlapping activity pair", async () => {
    const result = await testCtx.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(Number(result[0]?.count)).toBe(2);
  });

  it("ramp rate does not double-count overlapping activities", async () => {
    await queryCache.invalidateAll();
    const { status, result } = await query("cyclingAdvanced.rampRate", {
      days: 30,
    });
    expect(status).toBe(200);

    const data = result.result.data;
    // With two 30-min activities at ~155 bpm across 2 ISO weeks, the ramp rate
    // should be modest. If double-counted, the load would be 2x and spike.
    expect(data.weeks.length).toBeGreaterThan(0);
    for (const week of data.weeks) {
      expect(Math.abs(week.rampRate)).toBeLessThan(10);
    }
  });

  it("resolves activity endpoints from a non-canonical member activity id", async () => {
    await queryCache.invalidateAll();

    const byId = await query("activity.byId", { id: memberActivityId });
    expect(byId.status).toBe(200);
    expect(byId.result.result.data).toMatchObject({
      id: canonicalActivityId,
      avgHr: 144,
      avgPower: 212,
      sampleCount: 1800,
    });

    const stream = await query("activity.stream", { id: memberActivityId, maxPoints: 100 });
    expect(stream.status).toBe(200);
    expect(stream.result.result.data).toEqual([
      {
        recordedAt: "2026-04-20T15:00:00.000Z",
        heartRate: 144,
        power: 212,
        speed: 8.1,
        cadence: 86,
        altitude: 120,
        lat: 47.6,
        lng: -122.3,
      },
    ]);

    const heartRateZones = await query("activity.hrZones", { id: memberActivityId });
    expect(heartRateZones.status).toBe(200);
    expect(heartRateZones.result.result.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ zone: 2, seconds: 120 })]),
    );

    expect(sensorStore.getActivitySummaries).toHaveBeenCalledWith(
      expect.arrayContaining([canonicalActivityId, memberActivityId]),
    );
    expect(sensorStore.getStream).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: canonicalActivityId,
        memberActivityIds: expect.arrayContaining([canonicalActivityId, memberActivityId]),
      }),
      100,
    );
    expect(sensorStore.getHeartRateZoneSeconds).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: canonicalActivityId,
        memberActivityIds: expect.arrayContaining([canonicalActivityId, memberActivityId]),
      }),
      190,
      50,
    );
  });
});
