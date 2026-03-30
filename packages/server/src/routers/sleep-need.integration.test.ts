import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";
import type { SleepNeedResult, SleepPerformanceInfo } from "./sleep-need.ts";
import type { WeeklyReportResult } from "./weekly-report.ts";

/**
 * Integration tests for sleep-need router.
 * Verifies that performance queries use v_sleep (deduped + computed efficiency)
 * instead of raw sleep_session.
 */
describe("sleep-need router integration", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert an Apple Health sleep session with stages but NO efficiency_pct.
    // The raw sleep_session row will have efficiency_pct = NULL, but v_sleep
    // should compute it from (deep + rem + light) / duration * 100.
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            efficiency_pct, sleep_type
          ) VALUES (
            'apple_health', ${DEFAULT_USER_ID},
            NOW() - INTERVAL '8 hours',
            NOW(),
            480, 60, 120, 240, 60,
            NULL, 'sleep'
          )`,
    );

    // Refresh v_sleep so the view picks up the inserted row and computes efficiency
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

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
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

  it("performance uses v_sleep computed efficiency instead of raw sleep_session", async () => {
    await queryCache.invalidateAll();
    const today = new Date().toISOString().slice(0, 10);
    const result = await query<SleepPerformanceInfo | null>("sleepNeed.performance", {
      endDate: today,
    });

    expect(result).not.toBeNull();
    // The view computes efficiency as (60 + 120 + 240) / 480 * 100 = 87.5%
    // If the query were still using raw sleep_session, efficiency would be
    // null → fallback to 85 (the old hardcoded default).
    expect(result?.efficiency).toBeCloseTo(87.5, 0);
    // Definitively NOT the null-fallback value of 85
    expect(result?.efficiency).not.toBe(85);
  });

  it("performance returns deduped sleep data from v_sleep", async () => {
    // Insert a second provider with lower priority and different duration
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_low_prio', 'Low Priority Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    // Set explicit provider priority: apple_health = 1 (highest), test_low_prio = 50
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES ('apple_health', 1)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 1`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES ('test_low_prio', 50)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 50`,
    );

    // Insert an overlapping sleep session from the low-priority provider
    // with very different duration (120 min vs 480 min)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            efficiency_pct, sleep_type
          ) VALUES (
            'test_low_prio', ${DEFAULT_USER_ID},
            NOW() - INTERVAL '7.5 hours',
            NOW() - INTERVAL '30 minutes',
            120, 20, 30, 50, 20,
            30, 'sleep'
          )`,
    );

    // Refresh v_sleep to re-run dedup
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
    await queryCache.invalidateAll();

    const today = new Date().toISOString().slice(0, 10);
    const result = await query<SleepPerformanceInfo | null>("sleepNeed.performance", {
      endDate: today,
    });

    expect(result).not.toBeNull();
    // v_sleep should pick the apple_health session (priority 1) with 480 min,
    // not the low-prio session with 120 min
    expect(result?.actualMinutes).toBe(480);
  });
});

/**
 * Integration tests for sleep data consistency when multiple non-nap sessions
 * fall on the same calendar date.
 *
 * When v_sleep dedup doesn't merge sessions (< 80% time overlap, e.g. WHOOP
 * 10pm-6am and Apple Health 11pm-5am), both survive as separate rows. The
 * sleep_nights CTE in calculate must aggregate per date (picking the longest
 * session), and the weekly report's sleep_daily must do the same.
 *
 * Bug: calculate uses a Map keyed by date, so the last row for each date
 * wins (arbitrary). Weekly report's sleep_daily JOIN fans out training data
 * when multiple rows share a date.
 */
describe("sleep data consistency: multiple sessions per date", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Two providers: whoop (priority 10) and apple_health (priority 50)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('whoop', 10, 10)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 10, sleep_priority = 10`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('apple_health', 50, 50)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 50, sleep_priority = 50`,
    );

    // Insert 14 days of sleep from BOTH providers with slightly different
    // time windows that DON'T overlap >80% — so v_sleep keeps both.
    // WHOOP: 22:00-06:00 (480 min), Apple Health: 22:30-05:30 (420 min)
    // Overlap = 22:30-05:30 = 7h; union = 22:00-06:00 = 8h; ratio = 7/8 = 0.875 > 0.8
    // To make them NOT overlap enough, shift AH by 1.5h: 23:30-05:00 (330 min)
    // Overlap = 23:30-05:00 = 5.5h; union = 22:00-06:00 = 8h; ratio = 5.5/8 = 0.6875 < 0.8
    for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
      // WHOOP session: 22:00-06:00 = 480 min
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, external_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'whoop', ${DEFAULT_USER_ID}, ${`w-${daysAgo}`},
              (CURRENT_DATE - ${daysAgo}::int)::timestamp + INTERVAL '22 hours',
              (CURRENT_DATE - ${daysAgo}::int + 1)::timestamp + INTERVAL '6 hours',
              480, 96, 106, 216, 62, 92.0, 'sleep'
            )`,
      );

      // Apple Health session: 23:30-05:00 = 330 min (doesn't overlap >80% with WHOOP)
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, external_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'apple_health', ${DEFAULT_USER_ID}, ${`ah-${daysAgo}`},
              (CURRENT_DATE - ${daysAgo}::int)::timestamp + INTERVAL '23 hours 30 minutes',
              (CURRENT_DATE - ${daysAgo}::int + 1)::timestamp + INTERVAL '5 hours',
              330, 50, 70, 160, 50, NULL, 'sleep'
            )`,
      );
    }

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

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
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

  it("sleep.list deduplicates to one session per date (longest wins)", async () => {
    await queryCache.invalidateAll();
    const rows = await query<{ duration_minutes: number | null }[]>("sleep.list", {
      days: 14,
    });
    // v_sleep has 28 rows (14 nights × 2 providers), but sleep.list
    // deduplicates to one per date, picking the longest session
    expect(rows.length).toBe(14);
    for (const row of rows) {
      // Each row should be the WHOOP session (480 min), not Apple Health (330 min)
      expect(row.duration_minutes).toBe(480);
    }
  });

  it("sleepNeed.calculate must pick the longest session per date, not an arbitrary one", async () => {
    await queryCache.invalidateAll();
    const endDate = new Date().toISOString().slice(0, 10);
    const result = await query<SleepNeedResult>("sleepNeed.calculate", { endDate });

    // Each recent night should show the WHOOP session's 480 min (the longest),
    // not Apple Health's 330 min.
    // BUG: the Map(nights.map(n => [n.date, n])) keeps the LAST row per date.
    // With ORDER BY started_at ASC, the Apple Health session (23:30) comes after
    // WHOOP (22:00), so the Map overwrites with 330 min.
    const nightsWithData = result.recentNights.filter((night) => night.actualMinutes !== null);
    expect(nightsWithData.length).toBeGreaterThan(0);
    for (const night of nightsWithData) {
      expect(night.actualMinutes).toBe(480);
    }
  });

  it("weekly report sleep avg must use longest session per date, not average duplicates", async () => {
    await queryCache.invalidateAll();
    // Use yesterday as endDate so the "current" ISO week always contains data.
    // Using today fails on Mondays when the new ISO week has no sleep data yet.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const endDate = yesterday.toISOString().slice(0, 10);
    const result = await query<WeeklyReportResult>("weeklyReport.report", {
      weeks: 2,
      endDate,
    });

    // All nights have WHOOP (480 min) and AH (330 min). The weekly avg should
    // be 480 (the longest per date), not (480 + 330) / 2 = 405.
    // BUG: sleep_daily returns both rows per date, and the LEFT JOIN to daily
    // fans out, so AVG(sl.duration_minutes) averages both = 405.
    const current = result.current;
    expect(current).not.toBeNull();
    expect(current?.avgSleepMinutes).toBe(480);
  });
});
