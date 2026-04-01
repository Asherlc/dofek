import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";

describe("efficiency.polarizationTrend integration", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  const MAX_HR = 190;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = ${MAX_HR}, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${TEST_USER_ID}`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // ── Single activity with all HR zones + boundary values (2 days ago) ──
    // Combines zone coverage and boundary testing in one activity to avoid
    // v_activity's overlap dedup merging separate activities.
    //
    // Zone boundaries at 190 max HR: Z1 < 152, Z2 = 152-170, Z3 >= 171
    //
    // Samples: 1300 Z1 + 400 Z2 + 200 Z3 = 1900 total
    await insertActivity("all-zones-ride", "cycling", 2, [
      { hr: 130, samples: 1200 }, // Z1: well below 80%
      { hr: 151, samples: 100 }, // Z1: just below boundary (151 < 152)
      { hr: 152, samples: 100 }, // Z2: exactly 80% HRmax boundary
      { hr: 160, samples: 200 }, // Z2: mid-zone
      { hr: 170, samples: 100 }, // Z2: just below 90%
      { hr: 171, samples: 100 }, // Z3: exactly 90% HRmax boundary
      { hr: 180, samples: 100 }, // Z3: well above 90%
    ]);

    // ── Z1-only ride, 21 days ago (guaranteed different week) → PI null ──
    await insertActivity("easy-ride", "cycling", 21, [{ hr: 120, samples: 1000 }]);

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);

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

  async function insertActivity(
    name: string,
    activityType: string,
    daysAgo: number,
    zones: Array<{ hr: number; samples: number }>,
  ) {
    const totalSamples = zones.reduce((sum, z) => sum + z.samples, 0);

    const actResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, ${activityType},
            CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
            CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${totalSamples}::int * INTERVAL '1 second',
            ${name}
          ) RETURNING id`,
    );
    const actId = actResult[0]?.id;
    if (!actId) throw new Error(`Failed to insert activity ${name}`);

    let sampleIndex = 0;
    for (const zone of zones) {
      for (let batchStart = 0; batchStart < zone.samples; batchStart += 100) {
        const batchEnd = Math.min(batchStart + 100, zone.samples);
        const metricValues: string[] = [];
        const sensorValues: string[] = [];
        for (let s = batchStart; s < batchEnd; s++) {
          const offset = sampleIndex + s;
          const ts = `CURRENT_TIMESTAMP - ${daysAgo} * INTERVAL '1 day' + ${offset} * INTERVAL '1 second'`;
          metricValues.push(
            `(${ts}, '${TEST_USER_ID}', '${actId}', 'test_provider', ${zone.hr}, 200)`,
          );
          sensorValues.push(
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${actId}', ${zone.hr}, NULL)`,
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'power', '${actId}', 200, NULL)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, activity_id, provider_id, heart_rate, power
          ) VALUES ${metricValues.join(",\n")}`),
        );
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.sensor_sample (
            recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
          ) VALUES ${sensorValues.join(",\n")}`),
        );
      }
      sampleIndex += zone.samples;
    }
  }

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

  interface PolarizationResult {
    maxHr: number | null;
    weeks: Array<{
      week: string;
      z1Seconds: number;
      z2Seconds: number;
      z3Seconds: number;
      polarizationIndex: number | null;
    }>;
  }

  it("returns maxHr from user profile", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    expect(result.maxHr).toBe(MAX_HR);
  });

  it("bins HR samples into correct %HRmax zones", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    const totalZ1 = result.weeks.reduce((sum, w) => sum + w.z1Seconds, 0);
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);

    // all-zones-ride: 1200 (130bpm) + 100 (151bpm) = 1300 Z1
    //                 100 (152bpm) + 200 (160bpm) + 100 (170bpm) = 400 Z2
    //                 100 (171bpm) + 100 (180bpm) = 200 Z3
    // easy-ride: 1000 (120bpm) Z1
    expect(totalZ1).toBe(2300);
    expect(totalZ2).toBe(400);
    expect(totalZ3).toBe(200);
  });

  it("places HR at exactly 80% HRmax (152) in Z2, not Z1", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    // If 152 bpm was in Z1 instead of Z2, total Z2 would be 300 not 400
    expect(totalZ2).toBe(400);
  });

  it("places HR at exactly 90% HRmax (171) in Z3, not Z2", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);
    // If 171 bpm was in Z2 instead of Z3, total Z3 would be 100 not 200
    expect(totalZ3).toBe(200);
  });

  it("returns null PI when a zone has zero samples", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    const z1OnlyWeek = result.weeks.find((w) => w.z2Seconds === 0 && w.z3Seconds === 0);
    expect(z1OnlyWeek).toBeDefined();
    if (z1OnlyWeek) {
      expect(z1OnlyWeek.polarizationIndex).toBeNull();
    }
  });

  it("computes Treff PI correctly from real zone data", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    const threeZoneWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(threeZoneWeek).toBeDefined();
    if (threeZoneWeek) {
      const total = threeZoneWeek.z1Seconds + threeZoneWeek.z2Seconds + threeZoneWeek.z3Seconds;
      const f1 = threeZoneWeek.z1Seconds / total;
      const f2 = threeZoneWeek.z2Seconds / total;
      const f3 = threeZoneWeek.z3Seconds / total;
      const expectedPi = Math.round(Math.log10((f1 / (f2 * f3)) * 100) * 1000) / 1000;
      expect(threeZoneWeek.polarizationIndex).toBe(expectedPi);
    }
  });

  it("does not require resting HR for zone calculation", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    expect(result.weeks.length).toBeGreaterThan(0);
    expect(result.maxHr).toBe(MAX_HR);
  });
});
