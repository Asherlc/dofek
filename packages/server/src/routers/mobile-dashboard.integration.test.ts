import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

/**
 * Integration tests for mobile-dashboard router.
 */
describe("mobile-dashboard router integration", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Seed provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Seed daily metrics for the dashboard (last 60 days)
    const today = new Date();
    for (let i = 0; i < 30; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, user_id, provider_id, resting_hr, hrv, respiratory_rate_avg
            ) VALUES (
              ${dateStr}, ${TEST_USER_ID}, 'test_provider',
              ${60 + i}, ${42 + i * 0.5}, ${14 + i * 0.1}
            )
            ON CONFLICT DO NOTHING`,
      );
    }

    // Seed sleep data for last night and sleep debt calculation
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
              sleep_type
            ) VALUES (
              'test_provider', ${TEST_USER_ID},
              NOW() - INTERVAL '8 hours', NOW(),
              480, 120, 96, 240, 24, 'sleep'
            )
            ON CONFLICT DO NOTHING`,
    );

    // Refresh materialized views so dashboard queries pick up the data
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);

    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  async function query<T = unknown>(input: Record<string, unknown> = {}): Promise<T> {
    await queryCache.invalidateAll();
    const res = await fetch(`${baseUrl}/api/trpc/mobileDashboard.dashboard?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`mobileDashboard.dashboard error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  it("returns dashboard data with readiness, sleep, strain, and other fields", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await query<{
      readiness: {
        score: number;
        date: string;
        components: Record<string, number>;
        weights: Record<string, number>;
      } | null;
      sleep: {
        lastNight: {
          date: string;
          durationMinutes: number;
          deepPct: number;
          remPct: number;
          lightPct: number;
          awakePct: number;
        } | null;
        sleepDebt: number;
      } | null;
      strain: {
        dailyStrain: number;
        acuteLoad: number;
        chronicLoad: number;
        workloadRatio: number | null;
        date: string | null;
      } | null;
      nextWorkout: { type: string; reason: string } | null;
      sleepNeed: { score: number; label: string } | null;
      anomalies: { needsAttention: boolean } | null;
      latestDate: string | null;
    }>({ endDate: today });

    expect(result).toBeDefined();
    // Should have readiness data (we seeded 30 days of metrics)
    expect(result.readiness).not.toBeNull();
    expect(result.readiness?.score).toBeGreaterThan(0);
    expect(result.readiness?.components).toBeDefined();
    expect(result.readiness?.weights).toBeDefined();

    // Should have sleep data (we seeded a sleep session)
    expect(result.sleep).not.toBeNull();
    expect(result.sleep?.lastNight).not.toBeNull();
    if (result.sleep?.lastNight) {
      expect(result.sleep.lastNight.durationMinutes).toBe(480);
    }

    // Should have strain data
    expect(result.strain).not.toBeNull();
  });

  it("includes nextWorkout recommendation when data exists", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await query<{
      nextWorkout: { type: string; reason: string } | null;
    }>({ endDate: today });

    // With 30 days of metrics, there should be training data for a recommendation
    if (result.nextWorkout) {
      expect(result.nextWorkout.type).toBeDefined();
      expect(result.nextWorkout.reason).toBeDefined();
    }
  });
});
