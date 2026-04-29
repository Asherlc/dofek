import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

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

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = ${MAX_HR}, resting_hr = ${RESTING_HR}, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${TEST_USER_ID}`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Daily metrics with resting HR (needed for LATERAL join in healthspan query)
    for (let i = 30; i >= 0; i--) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, resting_hr, steps, vo2max
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${TEST_USER_ID}, ${RESTING_HR}, 10000, 45
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Activity with 5-second HR intervals (simulating Apple Health) ──
    // 600 seconds total (10 minutes), sampled every 5 seconds = 120 samples
    // First 300 seconds (60 samples): HR 140 (aerobic, below 162 threshold)
    // Last  300 seconds (60 samples): HR 175 (high intensity, above 162 threshold)
    const actResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'cycling',
            CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '600 seconds',
            'Apple Watch HIIT'
          ) RETURNING id`,
    );
    const actId = actResult[0]?.id;
    if (!actId) throw new Error("Failed to insert activity");

    const sensorValues: string[] = [];
    for (let sample = 0; sample < 120; sample++) {
      const offsetSeconds = sample * 5; // 5-second intervals
      const hr = sample < 60 ? 140 : 175; // first half aerobic, second half high intensity
      const ts = `CURRENT_TIMESTAMP - INTERVAL '2 days' + ${offsetSeconds} * INTERVAL '1 second'`;
      sensorValues.push(
        `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${actId}', ${hr}, NULL)`,
      );
    }
    await testCtx.db.execute(
      sql.raw(`INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
      ) VALUES ${sensorValues.join(",\n")}`),
    );

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

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testCtx.db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement`,
    );
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

    const app = createApp(testCtx.db);
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
    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4 });

    const highIntensity = result.metrics.find((m) => m.name === "High Intensity");
    expect(highIntensity).toBeDefined();
    expect(highIntensity?.value).not.toBeNull();

    // Activity has 120 samples at 5-second intervals = 600 seconds total.
    // 60 samples (300 seconds = 5 minutes) are above the 162 bpm threshold.
    // Weekly average over 4 weeks: ~5 / 4 = ~1.25 min/week.
    //
    // BUG (old code): COUNT(*) / 60 = 60 / 60 = 1 minute total → ~0.25 min/week
    // FIX (new code): SUM(interval) / 60 = 300 / 60 = 5 minutes total → ~1.25 min/week
    //
    // The fixed value should be ~5x larger than the buggy value.
    // We check that the weekly value is > 0.5 min/week (the buggy code would give ~0.25).
    if (highIntensity?.value != null) {
      expect(highIntensity.value).toBeGreaterThan(0.5);
    }

    // And the aerobic minutes should also reflect actual time
    const aerobic = result.metrics.find((m) => m.name === "Aerobic Activity");
    expect(aerobic).toBeDefined();
    expect(aerobic?.value).not.toBeNull();
    // 60 samples * 5 seconds = 300 seconds = 5 minutes aerobic total → ~1.25 min/week
    if (aerobic?.value != null) {
      expect(aerobic.value).toBeGreaterThan(0.5);
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

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);

    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4 });

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
    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4 });

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
    const actResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'cycling',
            CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '600 seconds',
            'Power Zone Intervals'
          ) RETURNING id`,
    );
    const actId = actResult[0]?.id;
    if (!actId) throw new Error("Failed to insert activity");

    const sensorValues: string[] = [];
    for (let sampleIndex = 0; sampleIndex < 120; sampleIndex++) {
      const offsetSeconds = sampleIndex * 5;
      const ts = `CURRENT_TIMESTAMP - INTERVAL '1 day' + ${offsetSeconds} * INTERVAL '1 second'`;
      sensorValues.push(
        `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'power', '${actId}', 230, NULL)`,
      );
    }
    await testCtx.db.execute(
      sql.raw(`INSERT INTO fitness.metric_stream (
        recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
      ) VALUES ${sensorValues.join(",\n")}`),
    );
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

    const summaryRows = await testCtx.db.execute<{ power_sample_count: number }>(
      sql`SELECT power_sample_count
          FROM fitness.activity_summary
          WHERE activity_id = ${actId}`,
    );
    expect(summaryRows[0]?.power_sample_count).toBe(120);

    const result = await query<HealthspanResult>("healthspan.score", { weeks: 4 });

    const highIntensity = result.metrics.find((m) => m.name === "High Intensity");
    expect(highIntensity).toBeDefined();
    expect(highIntensity?.value).not.toBeNull();

    if (highIntensity?.value != null) {
      expect(highIntensity.value).toBeGreaterThan(3);
    }
  });
});
