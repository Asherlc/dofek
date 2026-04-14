import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

/**
 * Integration tests for sleep router endpoints.
 * Verifies that the to_char SQL formatting returns ISO 8601 timestamps
 * parseable by strict JS engines (Firefox).
 */
describe("sleep router integration", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert provider (foreign key for sleep_session)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert a sleep session
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            efficiency_pct, sleep_type
          ) VALUES (
            'test_provider', ${TEST_USER_ID},
            NOW() - INTERVAL '6 hours',
            NOW(),
            360, 54, 79, 200, 27,
            92.5, 'sleep'
          )`,
    );

    // Refresh materialized view so v_sleep picks up the inserted row
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

  /** sleep.list returns local (wall-clock) timestamps without Z suffix */
  const LOCAL_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  /** sleep.latest returns UTC timestamps with Z suffix */
  const UTC_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  it("sleep.list returns started_at as local ISO 8601 (no Z)", async () => {
    await queryCache.invalidateAll();
    const rows = await query<{ started_at: string }[]>("sleep.list", { days: 30 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.started_at).toMatch(LOCAL_ISO_REGEX);
      expect(new Date(row.started_at).getTime()).not.toBeNaN();
    }
  });

  it("sleep.latest returns started_at in UTC ISO 8601 format", async () => {
    await queryCache.invalidateAll();
    const row = await query<{ started_at: string } | null>("sleep.latest");
    expect(row).not.toBeNull();
    if (row) {
      expect(row.started_at).toMatch(UTC_ISO_REGEX);
      expect(new Date(row.started_at).getTime()).not.toBeNaN();
    }
  });

  it("sleep.list coerces numeric columns from pg driver", async () => {
    await queryCache.invalidateAll();
    const rows = await query<
      { duration_minutes: number; deep_minutes: number | null; efficiency_pct: number | null }[]
    >("sleep.list", { days: 30 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.duration_minutes).toBe("number");
      if (row.deep_minutes !== null) {
        expect(typeof row.deep_minutes).toBe("number");
      }
      if (row.efficiency_pct !== null) {
        expect(typeof row.efficiency_pct).toBe("number");
      }
    }
  });

  it("sleep.latestStages falls back to overlapping session when winning provider has no stages", async () => {
    await queryCache.invalidateAll();

    // Insert a second provider (simulating WHOOP winning dedup but having no stages)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('whoop', 1, 1)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 1, sleep_priority = 1`,
    );

    // WHOOP session: higher priority, no stages
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            sleep_type
          ) VALUES (
            'whoop', ${TEST_USER_ID},
            NOW() - INTERVAL '7 hours',
            NOW() - INTERVAL '30 minutes',
            390, 60, 90, 200, 40,
            'sleep'
          )`,
    );

    // Insert stages for the existing test_provider session (simulating Apple Health)
    const sessionRows = await executeWithSchema(
      testCtx.db,
      z.object({ id: z.string() }),
      sql`SELECT id FROM fitness.sleep_session
          WHERE provider_id = 'test_provider' AND user_id = ${TEST_USER_ID}
          ORDER BY started_at DESC LIMIT 1`,
    );
    const sessionId = sessionRows[0]?.id;
    expect(sessionId).toBeDefined();

    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at)
          VALUES
            (${sessionId}::uuid, 'light', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours'),
            (${sessionId}::uuid, 'deep', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours'),
            (${sessionId}::uuid, 'rem', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '3 hours')`,
    );

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep`);

    const stages =
      await query<{ stage: string; started_at: string; ended_at: string }[]>("sleep.latestStages");

    expect(stages.length).toBe(3);
    expect(stages.map((stage) => stage.stage)).toEqual(["light", "deep", "rem"]);
  });

  it("sleep.latestStages returns overlapping stages even when the staged session starts more than two hours earlier", async () => {
    await queryCache.invalidateAll();

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health_overlap', 'Apple Health Overlap', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop_overlap', 'WHOOP Overlap', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
          VALUES ('whoop_overlap', 1, 1)
          ON CONFLICT (provider_id) DO UPDATE SET priority = 1, sleep_priority = 1`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            sleep_type
          ) VALUES (
            'apple_health_overlap', ${TEST_USER_ID},
            NOW() - INTERVAL '8 hours',
            NOW() - INTERVAL '30 minutes',
            450, 90, 90, 210, 60,
            'sleep'
          )`,
    );

    const stagedSessionRows = await executeWithSchema(
      testCtx.db,
      z.object({ id: z.string() }),
      sql`SELECT id FROM fitness.sleep_session
          WHERE provider_id = 'apple_health_overlap' AND user_id = ${TEST_USER_ID}
          ORDER BY started_at DESC LIMIT 1`,
    );
    const stagedSessionId = stagedSessionRows[0]?.id;
    expect(stagedSessionId).toBeDefined();

    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at)
          VALUES
            (${stagedSessionId}::uuid, 'light', NOW() - INTERVAL '8 hours', NOW() - INTERVAL '6 hours'),
            (${stagedSessionId}::uuid, 'deep', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '4 hours'),
            (${stagedSessionId}::uuid, 'rem', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '2 hours')`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            sleep_type
          ) VALUES (
            'whoop_overlap', ${TEST_USER_ID},
            NOW() - INTERVAL '3 hours',
            NOW(),
            180, 20, 40, 100, 20,
            'sleep'
          )`,
    );

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep`);

    const stages =
      await query<{ stage: string; started_at: string; ended_at: string }[]>("sleep.latestStages");

    expect(stages.length).toBe(3);
    expect(stages.map((stage) => stage.stage)).toEqual(["light", "deep", "rem"]);
  });
});
