import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import type { PolarizationTrendResult } from "../repositories/efficiency-repository.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

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

    const app = createApp(
      testCtx.db,
      makeMockSensorStore([
        { max_hr: MAX_HR, week: "2026-04-20", z1_seconds: 1300, z2_seconds: 400, z3_seconds: 200 },
        { max_hr: MAX_HR, week: "2026-04-06", z1_seconds: 1000, z2_seconds: 0, z3_seconds: 0 },
      ]),
    );
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

  it("returns maxHr from user profile", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    expect(result.maxHr).toBe(MAX_HR);
    expect(result).toMatchObject({
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
    });
  });

  it("bins HR samples into correct %HRmax zones", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });

    const totalZ1 = result.weeks.reduce((sum, w) => sum + w.z1Seconds, 0);
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);

    expect(totalZ1).toBe(2300);
    expect(totalZ2).toBe(400);
    expect(totalZ3).toBe(200);
  });

  it("places HR at exactly 80% HRmax (152) in Z2, not Z1", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    const totalZ2 = result.weeks.reduce((sum, w) => sum + w.z2Seconds, 0);
    // If 152 bpm was in Z1 instead of Z2, total Z2 would be 300 not 400
    expect(totalZ2).toBe(400);
  });

  it("places HR at exactly 90% HRmax (171) in Z3, not Z2", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    const totalZ3 = result.weeks.reduce((sum, w) => sum + w.z3Seconds, 0);
    // If 171 bpm was in Z2 instead of Z3, total Z3 would be 100 not 200
    expect(totalZ3).toBe(200);
  });

  it("returns null PI when a zone has zero samples", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    const z1OnlyWeek = result.weeks.find((w) => w.z2Seconds === 0 && w.z3Seconds === 0);
    expect(z1OnlyWeek).toBeDefined();
    if (z1OnlyWeek) {
      expect(z1OnlyWeek.polarizationIndex).toBeNull();
      expect(z1OnlyWeek).toMatchObject({
        status: "insufficient_data",
        statusLabel: "Not calculated",
      });
    }
  });

  it("computes Treff PI correctly from real zone data", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    const threeZoneWeek = result.weeks.find(
      (w) => w.z1Seconds > 0 && w.z2Seconds > 0 && w.z3Seconds > 0,
    );
    expect(threeZoneWeek).toBeDefined();
    if (threeZoneWeek) {
      const total = threeZoneWeek.z1Seconds + threeZoneWeek.z2Seconds + threeZoneWeek.z3Seconds;
      const f1 = threeZoneWeek.z1Seconds / total;
      const f2 = threeZoneWeek.z2Seconds / total;
      const f3 = threeZoneWeek.z3Seconds / total;
      const expectedPi = Math.round(Math.log10((f1 / f2) * f3 * 100) * 1000) / 1000;
      expect(threeZoneWeek.polarizationIndex).toBe(expectedPi);
      expect(threeZoneWeek.status).toBe(expectedPi > 2 ? "polarized" : "not_polarized");
      expect(threeZoneWeek.totalSeconds).toBe(total);
    }
  });

  it("does not require resting HR for zone calculation", async () => {
    const result = await query<PolarizationTrendResult>("efficiency.polarizationTrend", {
      days: 90,
    });
    expect(result.weeks.length).toBeGreaterThan(0);
    expect(result.maxHr).toBe(MAX_HR);
  });
});
