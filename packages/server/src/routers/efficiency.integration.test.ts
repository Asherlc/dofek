import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
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
  // Zone boundaries: Z1 < 152, Z2 = 152-170, Z3 >= 171
  const Z1_HR = 130; // well below 80% of 190 (152)
  const Z2_HR = 160; // between 80% (152) and 90% (171)
  const Z3_HR = 180; // above 90% of 190 (171)
  const Z2_BOUNDARY_HR = 152; // exactly 80% of 190
  const Z3_BOUNDARY_HR = 171; // exactly 90% of 190

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile with known max HR, no resting HR needed for %HRmax zones
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = ${MAX_HR}, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${DEFAULT_USER_ID}`,
    );

    // Insert provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // ── Activity 1: All three zones present → PI should be non-null ──
    // Place 2 days ago to ensure it's within the current week
    await insertActivityWithHrZones("polarized-ride", "cycling", 2, [
      { hr: Z1_HR, samples: 1200 },
      { hr: Z2_HR, samples: 200 },
      { hr: Z3_HR, samples: 100 },
    ]);

    // ── Activity 2: Boundary test in same day ──
    // 152 bpm = exactly 80% of 190 → should be Z2 (>= 80%)
    // 171 bpm = exactly 90% of 190 → should be Z3 (>= 90%)
    await insertActivityWithHrZones("boundary-ride", "cycling", 2, [
      { hr: 151, samples: 100 }, // Z1: < 152
      { hr: Z2_BOUNDARY_HR, samples: 100 }, // Z2: exactly 80% HRmax
      { hr: 170, samples: 100 }, // Z2: just below 90%
      { hr: Z3_BOUNDARY_HR, samples: 100 }, // Z3: exactly 90% HRmax
    ]);

    // ── Activity 3: Z1-only ride, 21 days ago (guaranteed different week) → PI null ──
    await insertActivityWithHrZones("easy-ride", "cycling", 21, [{ hr: 120, samples: 1000 }]);

    // Refresh materialized views
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);

    // Start server
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

  async function insertActivityWithHrZones(
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
            'test_provider', ${DEFAULT_USER_ID}, ${activityType},
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
        const values: string[] = [];
        for (let s = batchStart; s < batchEnd; s++) {
          const offset = sampleIndex + s;
          values.push(
            `(CURRENT_TIMESTAMP - ${daysAgo} * INTERVAL '1 day' + ${offset} * INTERVAL '1 second',
              '${DEFAULT_USER_ID}', '${actId}', 'test_provider', ${zone.hr}, 200)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, activity_id, provider_id, heart_rate, power
          ) VALUES ${values.join(",\n")}`),
        );
      }
      sampleIndex += zone.samples;
    }
  }

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    queryCache.clear();
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

  it("bins HR samples into correct %HRmax zones using simple thresholds", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    expect(result.weeks.length).toBeGreaterThan(0);

    // Sum zone totals across all weeks to verify total binning
    const totalZ1 = result.weeks.reduce((sum, w) => sum + w.z1Seconds, 0);
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);

    // Activity 1: 1200 Z1, 200 Z2, 100 Z3
    // Activity 2: 100 Z1 (151bpm), 100 Z2 (152bpm), 100 Z2 (170bpm), 100 Z3 (171bpm)
    // Activity 3: 1000 Z1
    // Total: Z1 = 1200 + 100 + 1000 = 2300, Z2 = 200 + 100 + 100 = 400, Z3 = 100 + 100 = 200
    expect(totalZ1).toBe(2300);
    expect(totalZ2).toBe(400);
    expect(totalZ3).toBe(200);
  });

  it("places HR at exactly 80% HRmax (152) in Z2, not Z1", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // Sum across weeks avoids week-boundary sensitivity
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    // If 152 bpm was wrongly placed in Z1, total Z2 would be 300 instead of 400
    expect(totalZ2).toBe(400);
  });

  it("places HR at exactly 90% HRmax (171) in Z3, not Z2", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);
    // If 171 bpm was wrongly placed in Z2, total Z3 would be 100 instead of 200
    expect(totalZ3).toBe(200);
  });

  it("returns null PI when a zone has zero samples", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // easy-ride (21 days ago) is Z1-only → that week should have null PI
    const z1OnlyWeek = result.weeks.find((w) => w.z2Seconds === 0 && w.z3Seconds === 0);
    expect(z1OnlyWeek).toBeDefined();
    if (z1OnlyWeek) {
      expect(z1OnlyWeek.polarizationIndex).toBeNull();
    }
  });

  it("computes Treff PI correctly from real zone data", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // Find a week with all three zones (activities 1+2 should be in the same week)
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
    // The whole point of switching to %HRmax zones: no resting HR dependency.
    // We inserted NO daily_metrics rows, yet polarization data should still work.
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    expect(result.weeks.length).toBeGreaterThan(0);
    expect(result.maxHr).toBe(MAX_HR);
  });
});
