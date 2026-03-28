import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";
import type { SleepPerformanceInfo } from "./sleep-need.ts";

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
