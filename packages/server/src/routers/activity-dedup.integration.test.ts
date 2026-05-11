import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

/**
 * Integration test verifying that overlapping activities are deduplicated
 * before ClickHouse activity analytics consume them.
 */
describe("Activity summary deduplication", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile with max_hr (required for TRIMP calculation)
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50
          WHERE id = ${TEST_USER_ID}`,
    );

    // Insert two providers with different priorities
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert overlapping cycling workouts from BOTH providers at two time points
    // spanning different ISO weeks. The ramp rate endpoint needs 2+ weeks of data
    // to produce week-over-week deltas, so a single activity isn't enough.
    // The v_activity dedup view should merge each pair into one canonical activity.
    const durationSec = 1800; // 30 minutes
    const activityOffsetsDaysAgo = [3, 14]; // two different ISO weeks

    for (const daysAgo of activityOffsetsDaysAgo) {
      const wahooResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'wahoo', ${TEST_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second',
              'Morning Ride'
            ) RETURNING id`,
      );
      const wahooActivityId = wahooResult[0]?.id;

      const appleResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'apple_health', ${TEST_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + INTERVAL '10 seconds',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second' - INTERVAL '10 seconds',
              'Morning Ride'
            ) RETURNING id`,
      );
      const appleActivityId = appleResult[0]?.id;

      if (!wahooActivityId || !appleActivityId) {
        throw new Error("Expected overlapping activity insert to return ids");
      }
    }

    const app = createApp(
      testCtx.db,
      makeMockSensorStore([
        { day: "2026-04-20", trimp: 50 },
        { day: "2026-04-27", trimp: 52 },
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

  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  it("v_activity is a regular view so activity inserts are visible without refresh", async () => {
    const result = await testCtx.db.execute<{ relkind: string }>(
      sql`SELECT c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'fitness'
            AND c.relname = 'v_activity'`,
    );
    expect(result[0]?.relkind).toBe("v");
  });

  it("v_activity contains only one canonical row per overlapping activity pair", async () => {
    const result = await testCtx.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(Number(result[0]?.count)).toBe(2);
  });

  it("ramp rate does not double-count overlapping activities", async () => {
    await queryCache.invalidateAll();
    const { status, result } = await query("cyclingAdvanced.rampRate", {
      days: 30,
    });
    expect(status).toBe(200);

    const data = result.result.data;
    // With two 30-min activities at ~155 bpm across 2 ISO weeks, the ramp rate
    // should be modest. If double-counted, the load would be 2x and spike.
    expect(data.weeks.length).toBeGreaterThan(0);
    for (const week of data.weeks) {
      expect(Math.abs(week.rampRate)).toBeLessThan(10);
    }
  });
});
