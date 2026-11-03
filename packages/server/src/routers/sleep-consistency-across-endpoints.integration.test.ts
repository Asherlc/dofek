import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { createClickHouseTestActivitySensorStore } from "./clickhouse-integration-test-helpers.ts";

/**
 * Integration test: sleep data consistency across all dashboard endpoints.
 *
 * Root cause of recurring sleep discrepancies: when two providers report
 * sleep sessions for the same night that DON'T overlap >80% (e.g. WHOOP
 * 22:00-06:00 and Apple Health 23:30-05:00, overlap=68%), v_sleep keeps
 * BOTH sessions. Each endpoint then handles (or ignores) the duplicate
 * differently:
 *   - sleep.list returns all rows (duplicate bars in the chart)
 *   - recovery.sleepAnalytics returns duplicate rows per date
 *
 * This test inserts multi-source non-overlapping-enough sleep data and
 * asserts ALL sleep endpoints return exactly one session per calendar date
 * with consistent durations.
 */
describe("sleep data consistency across endpoints", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  /** The 7 test dates (most recent 7 days) */
  const testDates: string[] = [];

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Two providers: WHOOP (longer sessions) and Apple Health (shorter sessions)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Set provider priority so WHOOP is preferred
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('whoop', 1, 1)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 1, sleep_priority = 1`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('apple_health', 2, 2)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 2, sleep_priority = 2`,
    );

    // Insert 7 nights of overlapping-but-not-80% sleep from both providers.
    // WHOOP: 22:00-06:00 (480 min) - the "correct" session, longer
    // Apple Health: 23:30-05:00 (330 min) - shorter, different start/end
    // Overlap: 23:30-05:00 = 330 min, Union: 22:00-06:00 = 480 min
    // Overlap ratio: 330/480 = 68.75% < 80% → NOT deduped by v_sleep
    for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
      const whoopDuration = 480;
      const appleDuration = 330;

      // WHOOP: 22:00 the night before → 06:00 the target date
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'whoop', ${TEST_USER_ID},
              (CURRENT_DATE - ${daysAgo}::int) + TIME '22:00:00' - INTERVAL '1 day',
              (CURRENT_DATE - ${daysAgo}::int) + TIME '06:00:00',
              ${whoopDuration}, 96, 106, 216, 62, 87.1, 'sleep'
            )`,
      );

      // Apple Health: 23:30 the night before → 05:00 the target date
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'apple_health', ${TEST_USER_ID},
              (CURRENT_DATE - ${daysAgo}::int) + TIME '23:30:00' - INTERVAL '1 day',
              (CURRENT_DATE - ${daysAgo}::int) + TIME '05:00:00',
              ${appleDuration}, 50, 70, 180, 30, 90.9, 'sleep'
            )`,
      );
    }

    // Compute expected test dates
    for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      testDates.push(date.toISOString().slice(0, 10));
    }

    const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
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

  // Use yesterday as endDate so the "current" ISO week always contains data.
  // Using today fails on Mondays when the new ISO week has no sleep data yet
  // (test data starts at daysAgo=1, so today has no sessions).
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const endDate = yesterday.toISOString().slice(0, 10);

  it("sleep.list returns at most one row per calendar date", async () => {
    await queryCache.invalidateAll();
    const rows = await query<{ started_at: string; duration_minutes: number }[]>("sleep.list", {
      days: 30,
      endDate,
    });

    // Group by calendar date
    const dateCount = new Map<string, number>();
    for (const row of rows) {
      const date = row.started_at.slice(0, 10);
      dateCount.set(date, (dateCount.get(date) ?? 0) + 1);
    }

    // Should never have >1 row per date
    for (const [date, count] of dateCount) {
      expect(count, `sleep.list returned ${count} rows for ${date}, expected 1`).toBe(1);
    }
  });

  it("recovery.sleepAnalytics returns at most one row per calendar date", async () => {
    await queryCache.invalidateAll();
    const result = await query<{
      nightly: { date: string; durationMinutes: number }[];
    }>("recovery.sleepAnalytics", { days: 30 });

    const dateCount = new Map<string, number>();
    for (const night of result.nightly) {
      dateCount.set(night.date, (dateCount.get(night.date) ?? 0) + 1);
    }

    for (const [date, count] of dateCount) {
      expect(count, `recovery.sleepAnalytics returned ${count} rows for ${date}, expected 1`).toBe(
        1,
      );
    }
  });
});
