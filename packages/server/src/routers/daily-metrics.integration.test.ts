import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";

/**
 * Integration tests for dailyMetrics data correctness.
 *
 * These tests insert realistic data and verify the query results match
 * expectations — catching SQL-level bugs that unit tests (which mock the DB)
 * cannot.
 */
describe("dailyMetrics data correctness", () => {
  const staleViewUserId = "00000000-0000-0000-0000-000000000002";
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  /**
   * Use a fixed endDate (CURRENT_DATE from the DB's perspective) so the
   * date window is deterministic regardless of when the test runs.
   */
  let endDate: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await queryCache.invalidateAll();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Get the DB's current date so endDate is consistent with inserted data
    const [{ today }] = await testCtx.db.execute<{ today: string }>(
      sql`SELECT CURRENT_DATE::text AS today`,
    );
    endDate = today;

    // Insert provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('garmin', 'Garmin Connect', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // ── Insert 30 days of daily metrics from apple_health with real data ──
    for (let i = 30; i >= 4; i--) {
      const rhr = 55 + Math.round(Math.cos(i * 0.3) * 5);
      const hrv = 50 + Math.round(Math.sin(i * 0.3) * 10);
      const steps = 8000 + Math.round(Math.sin(i) * 2000);
      const activeEnergy = 400 + Math.round(Math.cos(i) * 100);
      const spo2 = 96 + Math.round(Math.sin(i * 0.5) * 2);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, resting_hr, hrv, steps,
              active_energy_kcal, spo2_avg
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'apple_health', ${TEST_USER_ID}, ${rhr}, ${hrv}, ${steps},
              ${activeEnergy}, ${spo2}
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Days 3, 2, 1, 0: garmin creates rows with NO health metrics ──
    // This simulates the production bug where garmin sync creates empty rows
    // for recent days, making latest_date point to a row with no actual data.
    for (let i = 3; i >= 0; i--) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, distance_km
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'garmin', ${TEST_USER_ID}, 0
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // Refresh the materialized view
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);

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

  async function queryWithCookie<T = unknown>(
    cookie: string,
    path: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    await queryCache.invalidateAll();
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-timezone": "UTC",
      },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    return queryWithCookie(sessionCookie, path, input);
  }

  describe("trends", () => {
    it("returns latest non-null metric values across the window", async () => {
      // endDate (today) only has garmin rows with no health metrics, so latest
      // metric values should come from the most recent day where each metric exists.
      const result = await query<{
        latest_date: string | null;
        latest_resting_hr: number | null;
        latest_hrv: number | null;
        latest_steps: number | null;
      }>("dailyMetrics.trends", { days: 30, endDate });

      expect(result).not.toBeNull();

      // latest_date still reflects the most recent row in the window.
      expect(result.latest_date).toBe(endDate);

      // Metrics should use latest available non-null values in the window.
      expect(result.latest_resting_hr).not.toBeNull();
      expect(result.latest_hrv).not.toBeNull();
      expect(result.latest_steps).not.toBeNull();
    });

    it("returns today's values when endDate has health data", async () => {
      // Query with endDate set to a day that has apple_health data (day 4)
      const dayWithData = subtractDays(endDate, 4);
      const result = await query<{
        latest_date: string | null;
        latest_resting_hr: number | null;
        latest_hrv: number | null;
        latest_steps: number | null;
      }>("dailyMetrics.trends", { days: 30, endDate: dayWithData });

      expect(result).not.toBeNull();
      expect(result.latest_date).toBe(dayWithData);
      expect(result.latest_resting_hr).not.toBeNull();
      expect(result.latest_hrv).not.toBeNull();
      expect(result.latest_steps).not.toBeNull();
    });

    it("returns averages computed across the full window", async () => {
      const result = await query<{
        avg_resting_hr: number | null;
        avg_hrv: number | null;
        avg_steps: number | null;
      }>("dailyMetrics.trends", { days: 30, endDate });

      expect(result).not.toBeNull();
      // Averages should be computed (not null) since we have 27 days of data
      expect(result.avg_resting_hr).not.toBeNull();
      expect(result.avg_hrv).not.toBeNull();
      expect(result.avg_steps).not.toBeNull();

      // Sanity check: averages should be in expected ranges
      expect(result.avg_resting_hr).toBeGreaterThan(40);
      expect(result.avg_resting_hr).toBeLessThan(100);
      expect(result.avg_steps).toBeGreaterThan(5000);
      expect(result.avg_steps).toBeLessThan(15000);
    });

    it("returns all-null values when no data exists in the window", async () => {
      // Use a 1-day window far in the future where no data exists.
      const result = await query<{
        avg_resting_hr: number | null;
        latest_resting_hr: number | null;
        latest_date: string | null;
      }>("dailyMetrics.trends", {
        days: 1,
        endDate: "2099-01-02",
      });

      // stats CTE returns a row of nulls (SQL aggregate on empty set),
      // and LEFT JOIN today produces no match — so all fields are null
      expect(result).not.toBeNull();
      expect(result.avg_resting_hr).toBeNull();
      expect(result.latest_resting_hr).toBeNull();
      expect(result.latest_date).toBeNull();
    });

    it("refreshes stale trends when today's steps were inserted after the materialized view refresh", async () => {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.user_profile (id, name)
            VALUES (${staleViewUserId}, 'Stale View User')
            ON CONFLICT (id) DO NOTHING`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('apple_health_stale_view', 'Apple Health', ${staleViewUserId})`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('garmin_stale_view', 'Garmin Connect', ${staleViewUserId})`,
      );

      for (let i = 7; i >= 1; i--) {
        await testCtx.db.execute(
          sql`INSERT INTO fitness.daily_metrics (
                date, provider_id, user_id, steps, active_energy_kcal
              ) VALUES (
                CURRENT_DATE - ${i}::int,
                'apple_health_stale_view',
                ${staleViewUserId},
                ${8000 + i * 100},
                ${400 + i * 10}
              )`,
        );
      }

      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, distance_km
            ) VALUES (
              CURRENT_DATE,
              'garmin_stale_view',
              ${staleViewUserId},
              5.2
            )`,
      );

      await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);

      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, steps, active_energy_kcal
            ) VALUES (
              CURRENT_DATE,
              'apple_health_stale_view',
              ${staleViewUserId},
              9876,
              543
            )`,
      );

      const staleSession = await createSession(testCtx.db, staleViewUserId);
      const staleSessionCookie = `session=${staleSession.sessionId}`;

      const result = await queryWithCookie<{
        avg_steps: number | null;
        latest_steps: number | null;
        latest_active_energy: number | null;
        latest_date: string | null;
      }>(staleSessionCookie, "dailyMetrics.trends", { days: 30, endDate });

      expect(result.latest_date).toBe(endDate);
      expect(result.latest_steps).toBe(9876);
      expect(result.latest_active_energy).toBe(543);
      expect(result.avg_steps).not.toBeNull();
    });
  });

  describe("list", () => {
    it("returns rows ordered by date ascending", async () => {
      const result = await query<Array<{ date: string }>>("dailyMetrics.list", {
        days: 30,
        endDate,
      });

      expect(result.length).toBeGreaterThan(0);

      // Verify ascending order
      for (let i = 1; i < result.length; i++) {
        expect(result[i].date >= result[i - 1].date).toBe(true);
      }
    });

    it("includes rows from all providers in the window", async () => {
      const result = await query<Array<{ date: string; source_providers: string[] }>>(
        "dailyMetrics.list",
        { days: 30, endDate },
      );

      // Should have rows for the garmin-only days too (they appear in the view)
      const todayRow = result.find((r) => r.date === endDate);
      expect(todayRow).toBeDefined();
    });

    it("respects the endDate lower bound", async () => {
      // endDate anchors the window: only rows after (endDate - days) are returned
      const pastEndDate = subtractDays(endDate, 10);
      const result = await query<Array<{ date: string }>>("dailyMetrics.list", {
        days: 5,
        endDate: pastEndDate,
      });

      // No row should be at or before the lower bound (pastEndDate - 5)
      const lowerBound = subtractDays(pastEndDate, 5);
      for (const row of result) {
        expect(row.date > lowerBound).toBe(true);
      }
    });
  });

  describe("hrvBaseline", () => {
    it("returns HRV with 60-day rolling stats", async () => {
      const result = await query<
        Array<{
          date: string;
          hrv: number | null;
          mean_60d: number | null;
          sd_60d: number | null;
          mean_7d: number | null;
        }>
      >("dailyMetrics.hrvBaseline", { days: 30, endDate });

      expect(result.length).toBeGreaterThan(0);

      // The rolling stats should be computed (not null for rows with data)
      const withHrv = result.filter((r) => r.hrv !== null);
      expect(withHrv.length).toBeGreaterThan(0);

      for (const row of withHrv) {
        expect(row.mean_60d).not.toBeNull();
        expect(row.mean_7d).not.toBeNull();
      }
    });
  });
});

/** Subtract days from a YYYY-MM-DD string, returning YYYY-MM-DD. */
function subtractDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}
