import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

/**
 * Integration test for healthspan zone time calculation.
 * Verifies that HR zone minutes use actual time intervals between samples,
 * not raw sample counts (which would undercount for providers like Apple Health
 * that sample HR every ~5 seconds instead of every 1 second).
 */
describe("healthspan zone time with variable-interval HR data", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  const MAX_HR = 190;
  const RESTING_HR = 50;
  const currentWeekStart = new Date();
  currentWeekStart.setUTCHours(0, 0, 0, 0);
  currentWeekStart.setUTCDate(
    currentWeekStart.getUTCDate() - ((currentWeekStart.getUTCDay() + 6) % 7),
  );
  const endDate = new Date(currentWeekStart.getTime() - 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = ${MAX_HR}, resting_hr = ${RESTING_HR}, birth_date = '1990-01-01'
          WHERE id = ${TEST_USER_ID}`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Daily metrics with steps. Resting HR is derived from raw sleep-window HR samples.
    for (let i = 30; i >= 0; i--) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, steps
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${TEST_USER_ID}, 10000
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // Every selected week has measured zone coverage, so unknown weeks do not
    // obscure the elapsed-time regression under the strict completeness contract.
    const metricStreamSeedRows: ClickHouseMetricStreamSeedRow[] = [];
    for (let week = 0; week < 4; week++) {
      const activityStartedAt = new Date(
        Date.parse(`${endDate}T12:00:00Z`) - week * 7 * 86_400_000,
      );
      const activityEndedAt = new Date(activityStartedAt.getTime() + 600_000);
      const actResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
          provider_id,user_id,external_id,canonical_type,provider_type,started_at,ended_at,name
        ) VALUES ('test_provider',${TEST_USER_ID},${`healthspan-apple-watch-hiit-${week}`},
          'cycling','cycling',${activityStartedAt},${activityEndedAt},'Apple Watch HIIT') RETURNING id`,
      );
      const actId = actResult[0]?.id;
      if (!actId) throw new Error("Failed to insert activity");
      for (let sample = 0; sample < 120; sample++) {
        metricStreamSeedRows.push({
          userId: TEST_USER_ID,
          recordedAt: new Date(activityStartedAt.getTime() + sample * 5_000).toISOString(),
          providerId: "test_provider",
          sourceType: "api",
          channel: "heart_rate",
          activityId: actId,
          scalar: sample < 60 ? 140 : 175,
        });
      }
    }

    // Sleep data (needed to avoid CROSS JOIN eliminating the row)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, sleep_type
          ) VALUES (
            'test_provider', ${TEST_USER_ID},
            CURRENT_DATE - INTERVAL '1 day' + INTERVAL '22 hours',
            CURRENT_DATE + INTERVAL '6 hours',
            480, 'sleep'
          )`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, sleep_type
          ) VALUES (
            'test_provider', ${TEST_USER_ID},
            CURRENT_DATE - INTERVAL '3 days' + INTERVAL '22 hours',
            CURRENT_DATE - INTERVAL '2 days' + INTERVAL '6 hours',
            480, 'sleep'
          )`,
    );
    const restingSleepStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    restingSleepStart.setHours(restingSleepStart.getHours() + 1);
    for (let index = 0; index < 30; index++) {
      const recordedAt = new Date(restingSleepStart.getTime() + index * 60_000).toISOString();
      metricStreamSeedRows.push({
        userId: TEST_USER_ID,
        recordedAt,
        providerId: "test_provider",
        sourceType: "api",
        channel: "heart_rate",
        scalar: RESTING_HR,
      });
    }

    const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
    await seedClickHouseMetricStreamRows(testCtx, metricStreamSeedRows);
    const app = createApp(testCtx.db, sensorStore);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    await queryCache.invalidateAll();
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  interface HealthspanResult {
    healthspanScore: number | null;
    metrics: {
      name: string;
      value: number | null;
      unit: string;
      score: number;
      status: string;
    }[];
    history: { weekStart: string; score: number }[];
    trend: "improving" | "declining" | "stable" | null;
  }

  it("computes high intensity minutes from actual time intervals, not sample counts", async () => {
    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4, endDate });

    const highIntensity = result.metrics.find((m) => m.name === "High Intensity");
    expect(highIntensity).toBeDefined();
    expect(highIntensity?.value).not.toBeNull();

    // Activity has 120 samples at 5-second intervals = 600 seconds total.
    // 60 samples (300 seconds = 5 minutes) are above the 162 bpm threshold.
    // Four measured weeks each contribute ~5 high-intensity minutes.
    //
    // Counting samples would yield only one minute per week instead of five.
    if (highIntensity?.value != null) {
      expect(highIntensity.value).toBeCloseTo(5, 0);
    }

    // And the aerobic minutes should also reflect actual time
    const aerobic = result.metrics.find((m) => m.name === "Aerobic Activity");
    expect(aerobic).toBeDefined();
    expect(aerobic?.value).not.toBeNull();
    // Each measured week has 60 samples * 5 seconds = 5 aerobic minutes.
    if (aerobic?.value != null) {
      expect(aerobic.value).toBeCloseTo(5, 0);
    }
  });

  it("sleep consistency score is not deflated by midnight wraparound", async () => {
    // This test verifies the bedtime stddev calculation handles midnight crossings correctly.
    // A person who goes to bed consistently at ~midnight (some nights 11 PM, some at 1 AM)
    // has a very consistent schedule — only ~60 min spread. Without the fix, raw
    // minutes-of-day (1380 vs 60) are 1320 apart, producing a huge stddev and score=0.
    //
    // sleepNightDate subtracts 6 hours: a 1 AM start on calendar day N → sleep_date = day N-1,
    // same as 11 PM on day N-1. So we must use sessions on alternate (non-adjacent) nights
    // to avoid the DISTINCT ON dedup collapsing them into one row per night.
    //
    // Sessions and their sleep_dates:
    //   daysAgo=14, 23:00 → sleep_date = today-14  (23:00 − 6h = 17:00 same day)
    //   daysAgo=12, 01:00 → sleep_date = today-13  (01:00 − 6h = 19:00 prev day)
    //   daysAgo=10, 23:10 → sleep_date = today-10
    //   daysAgo=8,  01:10 → sleep_date = today-9
    //   daysAgo=6,  23:20 → sleep_date = today-6
    //   daysAgo=4,  01:20 → sleep_date = today-5
    //   daysAgo=2,  23:30 → sleep_date = today-2
    //
    // True bedtime stddev (normalized, with 1 AM → 1500 min):
    //   values: 1380, 1500, 1390, 1510, 1400, 1520, 1410  → stddev ≈ 58 min → score ≈ 36
    // Without the fix (raw minutes, 1 AM = 60):
    //   values: 1380, 60, 1390, 70, 1400, 80, 1410  → stddev ≈ 665 min → score = 0

    const midnightNights = [
      { daysAgo: 14, hour: 23, minute: 0 },
      { daysAgo: 12, hour: 1, minute: 0 },
      { daysAgo: 10, hour: 23, minute: 10 },
      { daysAgo: 8, hour: 1, minute: 10 },
      { daysAgo: 6, hour: 23, minute: 20 },
      { daysAgo: 4, hour: 1, minute: 20 },
      { daysAgo: 2, hour: 23, minute: 30 },
    ];

    for (const night of midnightNights) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, sleep_type
            ) VALUES (
              'test_provider', ${TEST_USER_ID},
              (CURRENT_DATE - ${night.daysAgo}::int)
                + make_time(${night.hour}, ${night.minute}, 0),
              (CURRENT_DATE - ${night.daysAgo}::int)
                + make_time(${night.hour}, ${night.minute}, 0)
                + INTERVAL '7 hours',
              420, 'sleep'
            )`,
      );
    }

    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4, endDate });

    const sleepConsistency = result.metrics.find((m) => m.name === "Sleep Consistency");
    expect(sleepConsistency).toBeDefined();
    // Score must be > 0. Without the midnight wraparound fix it would be 0.
    expect(sleepConsistency?.score).toBeGreaterThan(0);
    // Stddev should reflect ~60 min spread, not hundreds of minutes
    if (sleepConsistency?.value != null) {
      expect(sleepConsistency.value).toBeLessThan(120);
    }
  });

  it("high intensity minutes are proportional to actual time, not sample count", async () => {
    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4, endDate });

    const highIntensity = result.metrics.find((m) => m.name === "High Intensity");
    expect(highIntensity).toBeDefined();
    expect(highIntensity?.value).not.toBeNull();

    const aerobic = result.metrics.find((m) => m.name === "Aerobic Activity");
    expect(aerobic).toBeDefined();
    expect(aerobic?.value).not.toBeNull();

    // Both zones have equal number of samples (60 each) AND equal actual time (300s each).
    // With the fix, they should be approximately equal.
    // With the bug (COUNT), they'd also be equal but 5x too small.
    // This test ensures the ratio is ~1:1 (within 20% tolerance for edge effects
    // from the last sample in each zone).
    if (highIntensity?.value != null && aerobic?.value != null) {
      const ratio = highIntensity.value / aerobic.value;
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.3);
    }
  });

  it("includes power zone high-intensity work when heart-rate samples are absent", async () => {
    const powerActivityStartedAt = new Date(`${endDate}T13:00:00Z`);
    const powerActivityEndedAt = new Date(powerActivityStartedAt.getTime() + 600_000);
    const actResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'healthspan-power-zone-intervals', 'cycling', 'cycling',
            ${powerActivityStartedAt},
            ${powerActivityEndedAt},
            'Power Zone Intervals'
          ) RETURNING id`,
    );
    const actId = actResult[0]?.id;
    if (!actId) throw new Error("Failed to insert activity");

    const powerMetricStreamSeedRows: ClickHouseMetricStreamSeedRow[] = [];
    for (let sampleIndex = 0; sampleIndex < 120; sampleIndex++) {
      const offsetSeconds = sampleIndex * 5;
      const recordedAt = new Date(
        powerActivityStartedAt.getTime() + offsetSeconds * 1000,
      ).toISOString();
      powerMetricStreamSeedRows.push({
        userId: TEST_USER_ID,
        recordedAt,
        providerId: "test_provider",
        sourceType: "api",
        channel: "power",
        activityId: actId,
        scalar: 230,
      });
    }
    await syncClickHouseTestActivitySensorStore(testCtx);
    await seedClickHouseMetricStreamRows(testCtx, powerMetricStreamSeedRows);
    const identitiesResult = await getClickHouseTestClient(testCtx).query({
      query: `SELECT toString(activity_id) AS activity_id
        FROM analytics.deduped_activities FINAL
        WHERE user_id=toUUID('${TEST_USER_ID}')
          AND has(member_activity_ids,toUUID('${actId}')) AND is_deleted=0`,
      format: "JSONEachRow",
    });
    const identities = z
      .array(z.object({ activity_id: z.uuid() }))
      .parse(await identitiesResult.json());
    expect(identities).toHaveLength(1);
    const canonicalActivityId = identities[0]?.activity_id;
    if (!canonicalActivityId) throw new Error("Power fixture has no canonical serving activity");
    await executeClickHouseTestCommand(
      testCtx,
      `INSERT INTO analytics.cycling_power_observation_rows
      (user_id,activity_id,normalized_power,source_refresh_version,model_version,is_deleted,refresh_version,refreshed_at)
      SELECT toUUID('${TEST_USER_ID}'),toUUID('${canonicalActivityId}'),230,
        greatest(toUInt64(1),max(refresh_version)),'test-observed-power',0,
        toUInt64(toUnixTimestamp64Nano(now64(9))),now64(9)
      FROM analytics.activity_summary_rows WHERE activity_id=toUUID('${canonicalActivityId}')`,
    );
    await executeClickHouseTestCommand(
      testCtx,
      `INSERT INTO analytics.cycling_power_history_rows
      SELECT toUUID('${TEST_USER_ID}'),max(source_refresh_version),today(),'test-reference',
        [(toFloat64(toUnixTimestamp64Micro(parseDateTime64BestEffort('${powerActivityStartedAt.toISOString()}',6)))/1000000,
          '${canonicalActivityId}',250.0,0.92,14.106666666666667,'${canonicalActivityId}',
          toFloat64(toUnixTimestamp64Micro(parseDateTime64BestEffort('${powerActivityStartedAt.toISOString()}',6)))/1000000,
          1200.0,300.0)],toUInt64(toUnixTimestamp64Nano(now64(9))),now64(9)
      FROM analytics.cycling_power_observation_rows FINAL WHERE user_id=toUUID('${TEST_USER_ID}')`,
    );
    await executeClickHouseTestCommand(
      testCtx,
      "REBUILD TEST ANALYTICS TABLE analytics.healthspan_activity_zone_minutes",
    );
    await executeClickHouseTestCommand(
      testCtx,
      "REBUILD TEST ANALYTICS TABLE analytics.weekly_healthspan",
    );

    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4, endDate });

    const highIntensity = result.metrics.find((m) => m.name === "High Intensity");
    expect(highIntensity).toBeDefined();
    expect(highIntensity?.value).not.toBeNull();

    if (highIntensity?.value != null) {
      expect(highIntensity.value).toBeGreaterThanOrEqual(7);
      expect(highIntensity.value).toBeLessThanOrEqual(8);
    }
  });
});
