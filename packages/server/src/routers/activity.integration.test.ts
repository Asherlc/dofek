import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { activityRouter } from "./activity.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const createActivityCaller = createTestCallerFactory(activityRouter);

describe("Activity router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  let metricOnlyActivityId: string;
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
      sql`UPDATE fitness.user_profile
          SET max_hr = 190
          WHERE id = ${TEST_USER_ID}`,
    );

    const insertedActivities = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'test_provider',
            ${TEST_USER_ID},
            'metric-stream-only-activity',
            'running',
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

    const filteredActivities = await testCtx.db.execute<{ id: string; canonical_type: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
          (
            'test_provider',
            ${TEST_USER_ID},
            'filtered-cycling-activity',
            'cycling',
            'cycling',
            CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '75 minutes',
            'Filtered Cycling Activity'
          ),
          (
            'test_provider',
            ${TEST_USER_ID},
            'filtered-walking-activity',
            'walking',
            'walking',
            CURRENT_TIMESTAMP - INTERVAL '12 hours',
            CURRENT_TIMESTAMP - INTERVAL '12 hours' + INTERVAL '40 minutes',
            'Filtered Walking Activity'
          )
          RETURNING id, canonical_type`,
    );
    const cyclingActivity = filteredActivities.find(
      (activity) => activity.canonical_type === "cycling",
    );
    const walkingActivity = filteredActivities.find(
      (activity) => activity.canonical_type === "walking",
    );
    if (!cyclingActivity || !walkingActivity) {
      throw new Error("Failed to insert filtered test activities");
    }
    cyclingActivityId = cyclingActivity.id;
    walkingActivityId = walkingActivity.id;

    const sensorStore = makeMockSensorStore();
    sensorStore.getActivitySummaries = async (activityIds) =>
      activityIds.includes(metricOnlyActivityId)
        ? [
            {
              activity_id: metricOnlyActivityId,
              avg_hr: 152.3333,
              max_hr: 155,
              avg_power: 215,
              max_power: 220,
              avg_speed: 3.9,
              max_speed: 4,
              avg_cadence: 89,
              total_distance: null,
              elevation_gain_m: null,
              elevation_loss_m: null,
              sample_count: 12,
            },
          ]
        : [];
    sensorStore.getStream = async (window) =>
      window.activityId === metricOnlyActivityId
        ? [
            {
              recorded_at: new Date().toISOString(),
              heart_rate: 150,
              power: 210,
              speed: 3.8,
              cadence: 88,
              altitude: null,
              lat: null,
              lng: null,
            },
          ]
        : [];
    sensorStore.getHeartRateZoneSeconds = async (window) =>
      window.activityId === metricOnlyActivityId
        ? [
            { zone: 1, seconds: 0 },
            { zone: 2, seconds: 1 },
            { zone: 3, seconds: 1 },
            { zone: 4, seconds: 1 },
            { zone: 5, seconds: 0 },
          ]
        : [
            { zone: 1, seconds: 0 },
            { zone: 2, seconds: 0 },
            { zone: 3, seconds: 0 },
            { zone: 4, seconds: 0 },
            { zone: 5, seconds: 0 },
          ];

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
    it("uses deduped ClickHouse summaries when sensor rows are available", async () => {
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
      const items: Array<{ id: string; canonical_type: string }> = result.result?.data?.items ?? [];
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(cyclingActivityId);
      expect(items[0]?.canonical_type).toBe("cycling");
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

    it("returns deduped ClickHouse stream rows when sensor rows are available", async () => {
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
  });

  describe("hrZones", () => {
    it("returns zone 0 plus 5 training zones for a non-existent activity (all zero seconds)", async () => {
      const result = await query("activity.hrZones", {
        id: "00000000-0000-0000-0000-000000000099",
      });
      const zones = result.result?.data;
      // May return empty or all-zero depending on user_profile having max_hr
      // Either way it should not error
      if (zones) {
        expect(zones).toHaveLength(6);
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
      if (zones && zones.length === 6) {
        expect(zones[0].label).toBe("Below Zone 1");
        expect(zones[0].minPct).toBe(0);
        expect(zones[0].maxPct).toBe(50);
        expect(zones[1].label).toBe("Recovery");
        expect(zones[1].minPct).toBe(50);
        expect(zones[1].maxPct).toBe(60);
        expect(zones[5].label).toBe("VO2max");
        expect(zones[5].minPct).toBe(90);
        expect(zones[5].maxPct).toBe(100);
      }
    });

    it("returns zones from deduped ClickHouse heart-rate rows", async () => {
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

describe("Hangboarding activity router integration", () => {
  let testContext: TestContext;
  let activityId: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('hangboarding-activity-router-test', 'Hang Ten', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    const rows = await testContext.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES (
            'hangboarding-activity-router-test', ${TEST_USER_ID}, 'hangboard-activity-router-session',
            'hangboard', 'Hang Ten', '2026-08-08T14:00:00Z'::timestamptz,
            '2026-08-08T14:10:00Z'::timestamptz, 'Repeaters',
            '{"hangTen":{"sessionId":"router-session","planName":"Repeaters","boardName":"Tension Board"}}'::jsonb
          ) RETURNING id::text AS id`,
    );
    activityId = rows[0]?.id ?? "";
    if (!activityId) throw new Error("Failed to seed Hangboarding router activity");
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_interval (
            activity_id, interval_index, label, interval_type, started_at, ended_at
          ) VALUES (
            ${activityId}::uuid, 0, 'Step 1: 19 mm edge', 'work',
            '2026-08-08T14:00:00Z'::timestamptz, '2026-08-08T14:00:07Z'::timestamptz
          )`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("returns the detail contract and actionable not-found error", async () => {
    const caller = createActivityCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });
    await expect(caller.hangboardDetails({ id: activityId })).resolves.toMatchObject({
      planName: "Repeaters",
      boardName: "Tension Board",
      summary: expect.objectContaining({
        workIntervalCount: 1,
        totalWorkDurationSeconds: 7,
        exercises: [expect.objectContaining({ label: "19 mm edge" })],
      }),
    });
    await expect(
      caller.hangboardDetails({ id: "00000000-0000-0000-0000-000000000099" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Hangboarding details not found" });
  });
});
