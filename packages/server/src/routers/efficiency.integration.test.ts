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

    // ── Activity 1: Well-polarized — heavy Z1, small Z2, small Z3 ──
    // Z1 (<152 bpm): 1200 samples at HR 130
    // Z2 (152-171 bpm): 200 samples at HR 160
    // Z3 (≥171 bpm): 100 samples at HR 180
    await insertActivityWithHrZones("polarized-ride", "cycling", 3, [
      { hr: 130, samples: 1200 }, // Z1: < 80% of 190 = < 152
      { hr: 160, samples: 200 }, // Z2: 80-90% of 190 = 152-171
      { hr: 180, samples: 100 }, // Z3: >= 90% of 190 = >= 171
    ]);

    // ── Activity 2: Same week, even distribution (not polarized) ──
    await insertActivityWithHrZones("even-ride", "cycling", 4, [
      { hr: 130, samples: 500 }, // Z1
      { hr: 160, samples: 500 }, // Z2
      { hr: 180, samples: 500 }, // Z3
    ]);

    // ── Activity 3: Different week, Z1-only (no Z2 or Z3) → PI should be null ──
    await insertActivityWithHrZones("easy-ride", "cycling", 14, [
      { hr: 120, samples: 1000 }, // Z1 only
    ]);

    // ── Activity 4: Boundary test — HR exactly at zone thresholds ──
    // 152 bpm = exactly 80% of 190 → should be Z2 (>= 80%)
    // 171 bpm = exactly 90% of 190 → should be Z3 (>= 90%)
    await insertActivityWithHrZones("boundary-ride", "cycling", 3, [
      { hr: 151, samples: 100 }, // Z1: < 152
      { hr: 152, samples: 100 }, // Z2: exactly 80% HRmax
      { hr: 170, samples: 100 }, // Z2: just below 90%
      { hr: 171, samples: 100 }, // Z3: exactly 90% HRmax
    ]);

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

  it("bins HR samples into correct %HRmax zones", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // Week containing activities 1, 2, and 4 (daysAgo 3-4 are same week as boundary-ride daysAgo 3)
    // Find the week with the most total data (the recent week with 3 activities)
    const recentWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(recentWeek).toBeDefined();

    if (recentWeek) {
      // Activities 1 + 2 + 4 contribute:
      // Z1: 1200 + 500 + 100 (HR 151) = 1800
      // Z2: 200 + 500 + 100 (HR 152) + 100 (HR 170) = 900
      // Z3: 100 + 500 + 100 (HR 171) = 700
      expect(recentWeek.z1Seconds).toBe(1800);
      expect(recentWeek.z2Seconds).toBe(900);
      expect(recentWeek.z3Seconds).toBe(700);
    }
  });

  it("places HR exactly at 80% HRmax in Z2 (not Z1)", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // boundary-ride inserts 100 samples at HR 152 (exactly 80% of 190)
    // and 100 at HR 151 (just below). The 152s should be in Z2, 151s in Z1.
    // We verify this by checking zone totals include the boundary samples.
    const recentWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(recentWeek).toBeDefined();

    // If boundary was wrong (152 in Z1 instead of Z2), Z2 would be 800 not 900
    if (recentWeek) {
      expect(recentWeek.z2Seconds).toBeGreaterThanOrEqual(900);
    }
  });

  it("places HR exactly at 90% HRmax in Z3 (not Z2)", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    const recentWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(recentWeek).toBeDefined();

    // If boundary was wrong (171 in Z2 instead of Z3), Z3 would be 600 not 700
    if (recentWeek) {
      expect(recentWeek.z3Seconds).toBeGreaterThanOrEqual(700);
    }
  });

  it("returns null PI when a zone has zero samples", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    // easy-ride (14 days ago) is Z1-only → that week should have null PI
    const z1OnlyWeek = result.weeks.find((w) => w.z2Seconds === 0 || w.z3Seconds === 0);
    expect(z1OnlyWeek).toBeDefined();
    if (z1OnlyWeek) {
      expect(z1OnlyWeek.polarizationIndex).toBeNull();
    }
  });

  it("computes Treff PI correctly from real zone data", async () => {
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });

    const recentWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(recentWeek).toBeDefined();

    if (recentWeek) {
      const total = recentWeek.z1Seconds + recentWeek.z2Seconds + recentWeek.z3Seconds;
      const f1 = recentWeek.z1Seconds / total;
      const f2 = recentWeek.z2Seconds / total;
      const f3 = recentWeek.z3Seconds / total;
      const expectedPi = Math.round(Math.log10((f1 / (f2 * f3)) * 100) * 1000) / 1000;

      expect(recentWeek.polarizationIndex).toBe(expectedPi);
    }
  });

  it("does not require resting HR for zone calculation (no daily metrics needed)", async () => {
    // The whole point of switching to %HRmax zones: no resting HR dependency.
    // We inserted NO daily_metrics rows, yet polarization data should still work.
    const result = await query<PolarizationResult>("efficiency.polarizationTrend", { days: 90 });
    expect(result.weeks.length).toBeGreaterThan(0);
    expect(result.maxHr).toBe(MAX_HR);
  });
});
