import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";

/**
 * Integration test verifying that activity_summary deduplicates overlapping
 * activities from multiple providers. Without the v_activity join, workouts
 * synced from e.g. Wahoo + Apple Health are double-counted in ramp rate,
 * PMC, and other aggregate queries.
 */
describe("Activity summary deduplication", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile with max_hr (required for TRIMP calculation)
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50
          WHERE id = ${DEFAULT_USER_ID}`,
    );

    // Insert two providers with different priorities
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert the same cycling workout from BOTH providers with overlapping times.
    // The v_activity dedup view should merge these into one canonical activity.
    const daysAgo = 3;
    const durationSec = 1800; // 30 minutes

    const wahooResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'wahoo', ${DEFAULT_USER_ID}, 'cycling',
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
            'apple_health', ${DEFAULT_USER_ID}, 'cycling',
            CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + INTERVAL '10 seconds',
            CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second' - INTERVAL '10 seconds',
            'Morning Ride'
          ) RETURNING id`,
    );
    const appleActivityId = appleResult[0]?.id;

    // Insert metric_stream data for BOTH activities (similar HR profiles)
    for (const [actId, providerId] of [
      [wahooActivityId, "wahoo"],
      [appleActivityId, "apple_health"],
    ] as const) {
      if (!actId) continue;
      for (let batchStart = 0; batchStart < durationSec; batchStart += 100) {
        const batchEnd = Math.min(batchStart + 100, durationSec);
        const values: string[] = [];
        for (let s = batchStart; s < batchEnd; s++) {
          const hr = 155 + Math.round(Math.sin(s * 0.01) * 8);
          values.push(
            `(CURRENT_TIMESTAMP - ${daysAgo} * INTERVAL '1 day' + ${s} * INTERVAL '1 second',
              '${DEFAULT_USER_ID}', '${actId}', '${providerId}', ${hr})`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, activity_id, provider_id, heart_rate
          ) VALUES ${values.join(",\n")}`),
        );
      }
    }

    // Refresh materialized views (v_activity first, then activity_summary)
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_activity`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

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

  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  it("activity_summary contains only one row for overlapping activities", async () => {
    const result = await testCtx.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM fitness.activity_summary
          WHERE user_id = ${DEFAULT_USER_ID}`,
    );
    // With dedup: 1 canonical activity. Without dedup: 2 (one per provider).
    expect(Number(result[0]?.count)).toBe(1);
  });

  it("ramp rate does not double-count overlapping activities", async () => {
    await queryCache.invalidateAll();
    const { status, result } = await query("cyclingAdvanced.rampRate", {
      days: 30,
    });
    expect(status).toBe(200);

    const data = result.result.data;
    // With a single 30-min activity at ~155 bpm, the ramp rate should be modest.
    // If double-counted, the load would be 2x and the ramp rate would spike.
    // The exact value depends on EWMA warmup, but it should be < 5 (safe range).
    if (data.weeks.length > 0) {
      for (const week of data.weeks) {
        expect(Math.abs(week.rampRate)).toBeLessThan(10);
      }
    }
  });
});
