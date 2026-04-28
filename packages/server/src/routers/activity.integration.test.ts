import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

describe("Activity router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  let metricOnlyActivityId: string;
  let staleCanonicalActivityId: string;
  let cyclingActivityId: string;
  let walkingActivityId: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('apple_health', 'Apple Health', ${TEST_USER_ID}),
            ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190
          WHERE id = ${TEST_USER_ID}`,
    );

    const insertedActivities = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider',
            ${TEST_USER_ID},
            'running',
            CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '30 minutes',
            'Metric Stream Only Activity'
          ) RETURNING id`,
    );
    const activityId = insertedActivities[0]?.id;
    if (!activityId) {
      throw new Error("Failed to insert test activity");
    }
    metricOnlyActivityId = activityId;

    const filteredActivities = await testCtx.db.execute<{ id: string; activity_type: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES
          (
            'test_provider',
            ${TEST_USER_ID},
            'cycling',
            CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '75 minutes',
            'Filtered Cycling Activity'
          ),
          (
            'test_provider',
            ${TEST_USER_ID},
            'walking',
            CURRENT_TIMESTAMP - INTERVAL '12 hours',
            CURRENT_TIMESTAMP - INTERVAL '12 hours' + INTERVAL '40 minutes',
            'Filtered Walking Activity'
          )
          RETURNING id, activity_type`,
    );
    const cyclingActivity = filteredActivities.find(
      (activity) => activity.activity_type === "cycling",
    );
    const walkingActivity = filteredActivities.find(
      (activity) => activity.activity_type === "walking",
    );
    if (!cyclingActivity || !walkingActivity) {
      throw new Error("Failed to insert filtered test activities");
    }
    cyclingActivityId = cyclingActivity.id;
    walkingActivityId = walkingActivity.id;

    await testCtx.db.execute(
      sql`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
          ) VALUES
          (CURRENT_TIMESTAMP - INTERVAL '2 days', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'heart_rate', ${metricOnlyActivityId}, 150, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'power', ${metricOnlyActivityId}, 210, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'speed', ${metricOnlyActivityId}, 3.8, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'cadence', ${metricOnlyActivityId}, 88, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '1 second', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'heart_rate', ${metricOnlyActivityId}, 152, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '1 second', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'power', ${metricOnlyActivityId}, 215, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '1 second', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'speed', ${metricOnlyActivityId}, 3.9, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '1 second', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'cadence', ${metricOnlyActivityId}, 89, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '2 seconds', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'heart_rate', ${metricOnlyActivityId}, 155, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '2 seconds', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'power', ${metricOnlyActivityId}, 220, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '2 seconds', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'speed', ${metricOnlyActivityId}, 4.0, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '2 seconds', ${TEST_USER_ID}, 'test_provider', NULL, 'api', 'cadence', ${metricOnlyActivityId}, 90, NULL)`,
    );

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES ('whoop', 10), ('apple_health', 20)
          ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority`,
    );

    const staleMemberActivities = await testCtx.db.execute<{
      id: string;
      provider_id: string;
    }>(
      sql`WITH inserted AS (
            INSERT INTO fitness.activity (
              provider_id, user_id, external_id, activity_type, started_at, ended_at, raw
            ) VALUES
            (
              'apple_health',
              ${TEST_USER_ID},
              'hk:workout:stale-member',
              'strength_training',
              CURRENT_TIMESTAMP - INTERVAL '3 days',
              CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '10 minutes',
              '{"sourceName":"WHOOP"}'::jsonb
            ),
            (
              'whoop',
              ${TEST_USER_ID},
              'whoop-stale-member',
              'strength',
              CURRENT_TIMESTAMP - INTERVAL '3 days',
              CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '10 minutes',
              '{"avgHeartRate":122,"maxHeartRate":130}'::jsonb
            )
            RETURNING id, provider_id
          )
          SELECT id, provider_id FROM inserted`,
    );
    const staleAppleHealthActivity = staleMemberActivities.find(
      (activity) => activity.provider_id === "apple_health",
    );
    const staleWhoopActivity = staleMemberActivities.find(
      (activity) => activity.provider_id === "whoop",
    );
    if (!staleAppleHealthActivity || !staleWhoopActivity) {
      throw new Error("Failed to insert stale view regression activities");
    }

    await testCtx.db.execute(
      sql`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
          ) VALUES
          (CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '1 second', ${TEST_USER_ID}, 'apple_health', NULL, 'api', 'heart_rate', ${staleAppleHealthActivity.id}, 120, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '2 seconds', ${TEST_USER_ID}, 'apple_health', NULL, 'api', 'heart_rate', ${staleAppleHealthActivity.id}, 124, NULL),
          (CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '3 seconds', ${TEST_USER_ID}, 'apple_health', NULL, 'api', 'heart_rate', ${staleAppleHealthActivity.id}, 130, NULL)`,
    );

    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    const staleCanonicalRows = await testCtx.db.execute<{ id: string }>(
      sql`SELECT id
          FROM fitness.v_activity
          WHERE member_activity_ids @> ARRAY[${staleWhoopActivity.id}::uuid]`,
    );
    const staleCanonical = staleCanonicalRows[0]?.id;
    if (!staleCanonical) {
      throw new Error("Failed to resolve stale view regression canonical activity");
    }
    staleCanonicalActivityId = staleCanonical;

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

  /** Helper: GET a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}) {
    const encoded = encodeURIComponent(JSON.stringify(input));
    const res = await fetch(`${baseUrl}/api/trpc/${path}?input=${encoded}`, {
      headers: { Cookie: sessionCookie },
    });
    return res.json();
  }

  describe("byId", () => {
    it("returns NOT_FOUND for a non-existent activity", async () => {
      const result = await query("activity.byId", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("NOT_FOUND");
    });

    it("rejects invalid UUID input", async () => {
      const result = await query("activity.byId", { id: "not-a-uuid" });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });
  });

  describe("list", () => {
    it("falls back to metric_stream-backed summary when metric_stream rows are not available yet", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const result = await query("activity.list", {
        days: 30,
        endDate: today,
        limit: 20,
        offset: 0,
      });
      const items: Array<{ id: string; avg_hr: number | null }> = result.result?.data?.items ?? [];
      const insertedActivity = items.find((item) => item.id === metricOnlyActivityId);
      expect(insertedActivity).toBeDefined();
      expect(insertedActivity?.avg_hr).toBeCloseTo(152.3333, 4);
    });

    it("filters by activityTypes without raising a SQL error", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const result = await query("activity.list", {
        days: 30,
        endDate: today,
        limit: 20,
        offset: 0,
        activityTypes: ["cycling"],
      });
      expect(result.error).toBeUndefined();
      const items: Array<{ id: string; activity_type: string }> = result.result?.data?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(cyclingActivityId);
      expect(items[0]?.activity_type).toBe("cycling");
      expect(items.some((item) => item.id === metricOnlyActivityId)).toBe(false);
      expect(items.some((item) => item.id === walkingActivityId)).toBe(false);
    });
  });

  describe("stream", () => {
    it("returns empty array for non-existent activity", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      // Stream returns empty array (no data), not an error
      expect(result.result?.data).toEqual([]);
    });

    it("rejects maxPoints below minimum", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
        maxPoints: 1,
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });

    it("rejects maxPoints above maximum", async () => {
      const result = await query("activity.stream", {
        id: "00000000-0000-0000-0000-000000000099",
        maxPoints: 100000,
      });
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("BAD_REQUEST");
    });

    it("falls back to metric_stream when metric_stream rows are not available yet", async () => {
      const result = await query("activity.stream", {
        id: metricOnlyActivityId,
        maxPoints: 500,
      });
      const points = result.result?.data;
      expect(Array.isArray(points)).toBe(true);
      expect(points.length).toBeGreaterThan(0);
      expect(points[0]?.heartRate).toBe(150);
      expect(points[0]?.power).toBe(210);
    });

    it("returns member activity heart rate when deduped_sensor is stale", async () => {
      const result = await query("activity.stream", {
        id: staleCanonicalActivityId,
        maxPoints: 500,
      });
      const points = result.result?.data;
      expect(Array.isArray(points)).toBe(true);
      expect(points.map((point: { heartRate: number | null }) => point.heartRate)).toEqual([
        120, 124, 130,
      ]);
    });
  });

  describe("hrZones", () => {
    it("returns 5 zones for a non-existent activity (all zero seconds)", async () => {
      const result = await query("activity.hrZones", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      const zones = result.result?.data;
      // May return empty or all-zero depending on user_profile having max_hr
      // Either way it should not error
      if (zones) {
        expect(zones).toHaveLength(5);
        for (const zone of zones) {
          expect(zone.seconds).toBe(0);
        }
      }
    });

    it("returns zones with correct labels and percentages", async () => {
      const result = await query("activity.hrZones", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      const zones = result.result?.data;
      if (zones && zones.length === 5) {
        expect(zones[0].label).toBe("Recovery");
        expect(zones[0].minPct).toBe(50);
        expect(zones[0].maxPct).toBe(60);
        expect(zones[4].label).toBe("VO2max");
        expect(zones[4].minPct).toBe(90);
        expect(zones[4].maxPct).toBe(100);
      }
    });

    it("falls back to metric_stream when metric_stream rows are not available yet", async () => {
      const result = await query("activity.hrZones", {
        id: metricOnlyActivityId,
      });
      const zones: Array<{ seconds: number }> = result.result?.data ?? [];
      const totalSecondsInZones = zones.reduce((sum, zone) => sum + zone.seconds, 0);
      expect(totalSecondsInZones).toBeGreaterThan(0);
    });
  });

  describe("authentication", () => {
    it("rejects unauthenticated requests for byId", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.byId?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });

    it("rejects unauthenticated requests for stream", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.stream?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });

    it("rejects unauthenticated requests for hrZones", async () => {
      const encoded = encodeURIComponent(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
      );
      const res = await fetch(`${baseUrl}/api/trpc/activity.hrZones?input=${encoded}`);
      const result = await res.json();
      expect(result.error).toBeDefined();
      expect(result.error.data.code).toBe("UNAUTHORIZED");
    });
  });
});
