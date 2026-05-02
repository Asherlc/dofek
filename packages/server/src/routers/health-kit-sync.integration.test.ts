import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

describe("HealthKit sync router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

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

  async function mutate(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(input),
    });
    return res.json();
  }

  describe("pushQuantitySamples - body measurements", () => {
    it("routes body mass samples to body_measurement table", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 82.5,
            unit: "kg",
            startDate: "2025-06-01T08:00:00Z",
            endDate: "2025-06-01T08:00:00Z",
            sourceName: "Apple Health",
            sourceBundle: "com.apple.Health",
            uuid: "body-mass-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);
      expect(result.result.data.errors).toEqual([]);

      // Verify in DB
      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.body_measurement
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:body-mass-uuid-1'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.weight_kg).toBeCloseTo(82.5, 1);
    });

    it("routes body fat percentage and multiplies by 100", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.18,
            unit: "%",
            startDate: "2025-06-01T08:00:00Z",
            endDate: "2025-06-01T08:00:00Z",
            sourceName: "Apple Health",
            sourceBundle: "com.apple.Health",
            uuid: "body-fat-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.body_measurement
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:body-fat-uuid-1'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.body_fat_pct).toBeCloseTo(18, 1);
    });
  });

  describe("pushQuantitySamples - daily metrics", () => {
    it("routes daily metric samples and aggregates additive metrics by date", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierStepCount",
            value: 3000,
            unit: "count",
            startDate: "2025-06-02T09:00:00Z",
            endDate: "2025-06-02T09:30:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "steps-uuid-1",
          },
          {
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            unit: "count",
            startDate: "2025-06-02T14:00:00Z",
            endDate: "2025-06-02T14:30:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "steps-uuid-2",
          },
          {
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 2500,
            unit: "m",
            startDate: "2025-06-02T09:00:00Z",
            endDate: "2025-06-02T09:30:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "distance-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(3);
      expect(result.result.data.errors).toEqual([]);

      // Check aggregated daily metrics
      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health'
              AND date = '2025-06-02'`,
      );
      expect(rows.length).toBe(1);
      // Steps should be summed: 3000 + 5000
      expect(rows[0]?.steps).toBe(8000);
      // Distance in km: 2500m / 1000
      expect(rows[0]?.distance_km).toBeCloseTo(2.5, 1);
    });

    it("uses average HRV for the day, including all samples", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 40,
            unit: "ms",
            startDate: "2025-06-02T01:00:00Z", // overnight reading
            endDate: "2025-06-02T01:00:05Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "hrv-integ-1",
          },
          {
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 120,
            unit: "ms",
            startDate: "2025-06-02T23:00:00Z", // Breathe session (inflated)
            endDate: "2025-06-02T23:00:05Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "hrv-integ-2",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(2);
      expect(result.result.data.errors).toEqual([]);

      const rows = await testCtx.db.execute(
        sql`SELECT hrv FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health'
              AND date = '2025-06-02'`,
      );
      expect(rows.length).toBe(1);
      // Average of 40ms and 120ms => 80ms
      expect(rows[0]?.hrv).toBeCloseTo(80, 1);
    });

    it("does not store provider VO2 Max as a daily metric", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierVO2Max",
            value: 48.5,
            unit: "mL/min·kg",
            startDate: "2025-06-03T10:00:00Z",
            endDate: "2025-06-03T10:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "vo2max-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health'
              AND date = '2025-06-03'`,
      );
      expect(rows.length).toBe(0);
    });
  });

  describe("pushQuantitySamples - metric stream", () => {
    it("routes heart rate samples to metric_stream table", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            startDate: "2025-06-04T12:00:00Z",
            endDate: "2025-06-04T12:00:05Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "hr-uuid-1",
          },
          {
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.98,
            unit: "%",
            startDate: "2025-06-04T12:00:00Z",
            endDate: "2025-06-04T12:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "spo2-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(2);

      const rows = await testCtx.db.execute(
        sql`SELECT channel, scalar FROM fitness.metric_stream
            WHERE provider_id = 'apple_health'
            ORDER BY recorded_at`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const hrRow = rows.find((r: Record<string, unknown>) => r.channel === "heart_rate");
      expect(hrRow).toBeDefined();
      expect(hrRow?.scalar).toBe(72);

      const spo2Row = rows.find((r: Record<string, unknown>) => r.channel === "spo2");
      expect(spo2Row).toBeDefined();
      expect(spo2Row?.scalar).toBeCloseTo(0.98, 2);
    });

    it("aggregates SpO2 from metric_stream into daily_metrics as percentage", async () => {
      // Push multiple SpO2 readings for the same day (stored as fractions 0-1)
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.96,
            unit: "%",
            startDate: "2025-07-01T08:00:00Z",
            endDate: "2025-07-01T08:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "spo2-agg-uuid-1",
          },
          {
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.98,
            unit: "%",
            startDate: "2025-07-01T14:00:00Z",
            endDate: "2025-07-01T14:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "spo2-agg-uuid-2",
          },
          {
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            unit: "%",
            startDate: "2025-07-01T20:00:00Z",
            endDate: "2025-07-01T20:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "spo2-agg-uuid-3",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(3);
      expect(result.result.data.errors).toEqual([]);

      // Verify daily_metrics.spo2_avg is populated as percentage (0-100 scale)
      const rows = await testCtx.db.execute(
        sql`SELECT spo2_avg FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health'
              AND date = '2025-07-01'`,
      );
      expect(rows.length).toBe(1);
      // Average of 0.96, 0.98, 0.97 = 0.97 → 97% on 0-100 scale
      expect(rows[0]?.spo2_avg).toBeCloseTo(97, 0);
    });

    it("aggregates wrist temperature from metric_stream into daily_metrics", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 33.2,
            unit: "degC",
            startDate: "2025-07-02T02:00:00Z",
            endDate: "2025-07-02T02:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "wrist-temp-uuid-1",
          },
          {
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 33.6,
            unit: "degC",
            startDate: "2025-07-02T04:00:00Z",
            endDate: "2025-07-02T04:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "wrist-temp-uuid-2",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(2);
      expect(result.result.data.errors).toEqual([]);

      // Verify daily_metrics.skin_temp_c is populated (average of 33.2 and 33.6 = 33.4)
      const rows = await testCtx.db.execute(
        sql`SELECT skin_temp_c FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health'
              AND date = '2025-07-02'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.skin_temp_c).toBeCloseTo(33.4, 1);
    });
  });

  describe("pushQuantitySamples - catch-all health events", () => {
    it("routes unknown types to health_event table", async () => {
      const result = await mutate("healthKitSync.pushQuantitySamples", {
        samples: [
          {
            type: "HKQuantityTypeIdentifierSomeUnknownType",
            value: 42,
            unit: "count",
            startDate: "2025-06-05T10:00:00Z",
            endDate: "2025-06-05T10:00:00Z",
            sourceName: "Third Party App",
            sourceBundle: "com.thirdparty.app",
            uuid: "unknown-uuid-1",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.health_event
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:unknown-uuid-1'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.type).toBe("HKQuantityTypeIdentifierSomeUnknownType");
      expect(rows[0]?.value).toBeCloseTo(42, 0);
    });
  });

  describe("pushWorkouts", () => {
    it("creates activity records from workout samples", async () => {
      const result = await mutate("healthKitSync.pushWorkouts", {
        workouts: [
          {
            uuid: "workout-uuid-1",
            workoutType: "37",
            startDate: "2025-06-06T06:00:00Z",
            endDate: "2025-06-06T06:45:00Z",
            duration: 2700,
            totalEnergyBurned: 350,
            totalDistance: 5000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.activity
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:workout:workout-uuid-1'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.activity_type).toBe("running");
    });

    it("maps unknown workout types to 'other'", async () => {
      const result = await mutate("healthKitSync.pushWorkouts", {
        workouts: [
          {
            uuid: "workout-uuid-unknown",
            workoutType: "999",
            startDate: "2025-06-06T10:00:00Z",
            endDate: "2025-06-06T10:30:00Z",
            duration: 1800,
            totalEnergyBurned: null,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.activity
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:workout:workout-uuid-unknown'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.activity_type).toBe("other");
    });
  });

  describe("pushSleepSamples", () => {
    it("creates sleep sessions with correct stage minutes", async () => {
      const result = await mutate("healthKitSync.pushSleepSamples", {
        samples: [
          {
            uuid: "sleep-inbed-1",
            startDate: "2025-06-07T22:00:00Z",
            endDate: "2025-06-08T06:30:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "sleep-deep-1",
            startDate: "2025-06-07T22:30:00Z",
            endDate: "2025-06-07T23:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "sleep-rem-1",
            startDate: "2025-06-07T23:30:00Z",
            endDate: "2025-06-08T00:30:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "sleep-light-1",
            startDate: "2025-06-08T00:30:00Z",
            endDate: "2025-06-08T04:30:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "sleep-awake-1",
            startDate: "2025-06-08T04:30:00Z",
            endDate: "2025-06-08T04:45:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.sleep_session
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:sleep:sleep-inbed-1:Apple Watch'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.deep_minutes).toBe(60);
      expect(rows[0]?.rem_minutes).toBe(60);
      expect(rows[0]?.light_minutes).toBe(240);
      expect(rows[0]?.awake_minutes).toBe(15);
      // Efficiency is not stored — derived in v_sleep view
      expect(rows[0]?.efficiency_pct).toBeNull();
    });

    it("derives a session from stage-only samples when inBed is missing", async () => {
      const result = await mutate("healthKitSync.pushSleepSamples", {
        samples: [
          {
            uuid: "stage-only-light-1",
            startDate: "2025-06-09T22:00:00Z",
            endDate: "2025-06-10T01:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-rem-1",
            startDate: "2025-06-10T01:00:00Z",
            endDate: "2025-06-10T02:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-deep-1",
            startDate: "2025-06-10T02:00:00Z",
            endDate: "2025-06-10T05:00:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-awake-1",
            startDate: "2025-06-10T05:00:00Z",
            endDate: "2025-06-10T05:15:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.result.data.inserted).toBe(1);

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.sleep_session
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:sleep:stage-only-light-1:Apple Watch'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.deep_minutes).toBe(180);
      expect(rows[0]?.rem_minutes).toBe(60);
      expect(rows[0]?.light_minutes).toBe(180);
      expect(rows[0]?.awake_minutes).toBe(15);
      // Efficiency is not stored — derived in v_sleep view
      expect(rows[0]?.efficiency_pct).toBeNull();
    });
  });

  describe("deduplication", () => {
    it("does not create duplicate body measurements on re-push", async () => {
      const samples = [
        {
          type: "HKQuantityTypeIdentifierBodyMass",
          value: 80.0,
          unit: "kg",
          startDate: "2025-06-10T08:00:00Z",
          endDate: "2025-06-10T08:00:00Z",
          sourceName: "Apple Health",
          sourceBundle: "com.apple.Health",
          uuid: "dedup-body-uuid-1",
        },
      ];

      await mutate("healthKitSync.pushQuantitySamples", { samples });
      await mutate("healthKitSync.pushQuantitySamples", { samples });

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.body_measurement
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:dedup-body-uuid-1'`,
      );
      expect(rows.length).toBe(1);
    });

    it("does not create duplicate workouts on re-push", async () => {
      const workouts = [
        {
          uuid: "dedup-workout-uuid-1",
          workoutType: "37",
          startDate: "2025-06-10T06:00:00Z",
          endDate: "2025-06-10T06:45:00Z",
          duration: 2700,
          totalEnergyBurned: 350,
          totalDistance: 5000,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
      ];

      await mutate("healthKitSync.pushWorkouts", { workouts });
      await mutate("healthKitSync.pushWorkouts", { workouts });

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.activity
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:workout:dedup-workout-uuid-1'`,
      );
      expect(rows.length).toBe(1);
    });

    it("does not create duplicate sleep sessions on re-push", async () => {
      const samples = [
        {
          uuid: "dedup-sleep-inbed-1",
          startDate: "2025-06-10T22:00:00Z",
          endDate: "2025-06-11T06:00:00Z",
          value: "inBed",
          sourceName: "Apple Watch",
        },
        {
          uuid: "dedup-sleep-deep-1",
          startDate: "2025-06-10T23:00:00Z",
          endDate: "2025-06-11T00:00:00Z",
          value: "asleepDeep",
          sourceName: "Apple Watch",
        },
      ];

      await mutate("healthKitSync.pushSleepSamples", { samples });
      await mutate("healthKitSync.pushSleepSamples", { samples });

      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.sleep_session
            WHERE provider_id = 'apple_health'
              AND external_id = 'hk:sleep:dedup-sleep-inbed-1:Apple Watch'`,
      );
      expect(rows.length).toBe(1);
    });
  });
});
