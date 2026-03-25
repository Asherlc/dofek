import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";

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

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert provider (foreign key for sleep_session)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert a sleep session
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
            provider_id, user_id, started_at, ended_at,
            duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
            efficiency_pct, sleep_type
          ) VALUES (
            'test_provider', ${DEFAULT_USER_ID},
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
});
