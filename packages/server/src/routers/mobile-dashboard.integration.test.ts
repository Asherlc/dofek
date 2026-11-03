import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { createClickHouseTestActivitySensorStore } from "./clickhouse-integration-test-helpers.ts";

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

    // Seed recorded sleep for last night.
    await testCtx.db.execute(
      sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
              staging_available, sleep_type
            ) VALUES (
              'test_provider', ${TEST_USER_ID},
              NOW() - INTERVAL '8 hours', NOW(),
              480, 120, 96, 240, 24, true, 'sleep'
            )
            ON CONFLICT DO NOTHING`,
    );

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

  it("returns recorded sleep duration and stage proportions", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await query<{
      sleep: {
        lastNight: {
          date: string;
          durationMinutes: number;
          deepPct: number | null;
          remPct: number | null;
          stagingAvailable: boolean;
        } | null;
      };
      latestDate: string | null;
    }>({ endDate: today });

    expect(result.sleep.lastNight).toMatchObject({
      date: today,
      durationMinutes: 480,
      deepPct: 25,
      remPct: 20,
      stagingAvailable: true,
    });
    expect(result.latestDate).toBe(today);
  });
});
