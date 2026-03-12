import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/__tests__/test-helpers.ts";
import { createApp } from "../index.ts";

describe("HealthKit sync router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
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
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    await testCtx?.cleanup();
  }, 30_000);

  async function mutate(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
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
            type: "HKQuantityTypeIdentifierRestingHeartRate",
            value: 55,
            unit: "count/min",
            startDate: "2025-06-02T07:00:00Z",
            endDate: "2025-06-02T07:00:00Z",
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.health",
            uuid: "rhr-uuid-1",
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

      expect(result.result.data.inserted).toBe(4);
      expect(result.result.data.errors).toEqual([]);

      // Check aggregated daily metrics
      const rows = await testCtx.db.execute(
        sql`SELECT * FROM fitness.daily_metrics
            WHERE provider_id = 'apple_health_kit'
              AND date = '2025-06-02'`,
      );
      expect(rows.length).toBe(1);
      // Steps should be summed: 3000 + 5000
      expect(rows[0]?.steps).toBe(8000);
      // Resting HR is point-in-time (latest value)
      expect(rows[0]?.resting_hr).toBe(55);
      // Distance in km: 2500m / 1000
      expect(rows[0]?.distance_km).toBeCloseTo(2.5, 1);
    });

    it("handles VO2Max as a point-in-time metric", async () => {
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
            WHERE provider_id = 'apple_health_kit'
              AND date = '2025-06-03'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.vo2max).toBeCloseTo(48.5, 1);
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
        sql`SELECT * FROM fitness.metric_stream
            WHERE provider_id = 'apple_health_kit'
            ORDER BY recorded_at`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const hrRow = rows.find((r: Record<string, unknown>) => r.heart_rate !== null);
      expect(hrRow).toBeDefined();
      expect(hrRow?.heart_rate).toBe(72);

      const spo2Row = rows.find((r: Record<string, unknown>) => r.spo2 !== null);
      expect(spo2Row).toBeDefined();
      expect(spo2Row?.spo2).toBeCloseTo(0.98, 2);
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
              AND external_id = 'hk:sleep:sleep-inbed-1'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.deep_minutes).toBe(60);
      expect(rows[0]?.rem_minutes).toBe(60);
      expect(rows[0]?.light_minutes).toBe(240);
      expect(rows[0]?.awake_minutes).toBe(15);
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
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
            WHERE provider_id = 'apple_health_kit'
              AND external_id = 'hk:sleep:dedup-sleep-inbed-1'`,
      );
      expect(rows.length).toBe(1);
    });
  });
});
