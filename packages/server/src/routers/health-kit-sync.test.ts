import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("dofek/sync-metrics", () => ({
  healthKitRecordsTotal: { add: vi.fn() },
  healthKitPushTotal: { add: vi.fn() },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import {
  aggregateDailyMetricSamples,
  computeBoundsFromIsoTimestamps,
  deriveSleepSessionsFromStages,
  healthKitSyncRouter,
  isSleepStageValue,
  type SleepSample,
} from "./health-kit-sync.ts";

const createCaller = createTestCallerFactory(healthKitSyncRouter);

function makeExecute() {
  return vi.fn().mockResolvedValue([]);
}

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    type: "HKQuantityTypeIdentifierStepCount",
    value: 1000,
    unit: "count",
    startDate: "2024-01-15T10:00:00Z",
    endDate: "2024-01-15T10:30:00Z",
    sourceName: "iPhone",
    sourceBundle: "com.apple.Health",
    uuid: "test-uuid-001",
    ...overrides,
  };
}

describe("healthKitSyncRouter", () => {
  beforeEach(() => {
    vi.mocked(healthKitRecordsTotal.add).mockClear();
    vi.mocked(healthKitPushTotal.add).mockClear();
  });

  describe("pushQuantitySamples", () => {
    it("uses the first HRV reading of the day (overnight) instead of averaging with Breathe sessions", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 45,
          startDate: "2024-01-15T04:00:00Z", // overnight reading (e.g. 11pm EST)
          endDate: "2024-01-15T04:00:05Z",
          uuid: "hrv-overnight",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 50,
          startDate: "2024-01-15T08:00:00Z", // early morning reading
          endDate: "2024-01-15T08:00:05Z",
          uuid: "hrv-morning",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 120,
          startDate: "2024-01-15T22:00:00Z", // Breathe session (high value)
          endDate: "2024-01-15T22:00:05Z",
          uuid: "hrv-breathe",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      // Should use the first reading (45ms overnight), NOT average (71.7ms)
      // or last-write-wins (120ms Breathe session)
      expect(jan15?.hrv).toBe(45);
    });

    it("uses the only HRV reading when there is just one", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 52,
          startDate: "2024-01-15T06:00:00Z",
          endDate: "2024-01-15T06:00:05Z",
          uuid: "hrv-only",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.hrv).toBe(52);
    });

    it("assigns HRV readings to the correct local date when timestamps include timezone offsets", () => {
      // iOS sends timestamps with local timezone offset so that extractDate
      // (which slices the first 10 chars) gets the correct calendar date.
      // Without timezone offsets, a 9:30 PM PDT reading would become
      // "2024-01-15T04:30:00Z" in UTC and be assigned to Jan 15 instead of Jan 14.
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 14, // low evening HRV (post-exercise)
          startDate: "2024-01-14T21:30:00-0700", // 9:30 PM PDT Jan 14
          endDate: "2024-01-14T21:30:05-0700",
          uuid: "hrv-evening",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 55, // normal overnight HRV reading on Jan 15
          startDate: "2024-01-15T06:00:00-0700", // 6 AM PDT Jan 15
          endDate: "2024-01-15T06:00:05-0700",
          uuid: "hrv-overnight",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);

      // The evening reading belongs to Jan 14 (local date)
      const jan14 = daily.get("2024-01-14\x00iPhone");
      expect(jan14?.hrv).toBe(14);

      // Jan 15 gets only the overnight reading
      const jan15 = daily.get("2024-01-15\x00iPhone");
      expect(jan15?.hrv).toBe(55);
    });

    it("processes body measurement samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "body-1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it("applies body fat percentage transform (value * 100)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.18,
            uuid: "bf-1",
          }),
        ],
      });

      const sqlCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("body_measurement") && serialized.includes("body_fat_pct");
      });
      expect(sqlCall).toBeDefined();
      const serialized = JSON.stringify(sqlCall?.[0]);
      // 0.18 * 100 = 18 — must NOT contain the un-transformed value 0.18 or the wrong-direction 0.0018
      expect(serialized).toContain(",18,");
      expect(serialized).not.toContain("0.0018");
      expect(serialized).not.toContain("0.18");
    });

    it("applies distance transform (value / 1000)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "dist-transform",
          }),
        ],
      });

      const sqlCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("distance_km");
      });
      expect(sqlCall).toBeDefined();
      // 5000 / 1000 = 5
      const serialized = JSON.stringify(sqlCall?.[0]);
      expect(serialized).toContain(",5,");
    });

    it("processes additive daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "s1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierActiveEnergyBurned",
            value: 300,
            uuid: "s2",
          }),
        ],
      });

      expect(result.inserted).toBe(2);
      expect(result.errors).toEqual([]);
    });

    it("aggregates a single pre-deduplicated statistics sample per day (no double-counting)", () => {
      // When iOS uses HKStatisticsCollectionQuery, it sends one sample per day
      // per type with the deduplicated total. Verify the accumulator produces
      // the correct value (not doubled or split across batches).
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 8500,
          startDate: "2024-01-15T12:00:00Z",
          endDate: "2024-01-15T12:00:00Z",
          uuid: "stat:steps:2024-01-15",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          value: 450,
          startDate: "2024-01-15T12:00:00Z",
          endDate: "2024-01-15T12:00:00Z",
          uuid: "stat:energy:2024-01-15",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.steps).toBe(8500);
      expect(jan15?.activeEnergyKcal).toBe(450);
    });

    it("does not double-count when raw samples from multiple sources are replaced by statistics", () => {
      // Before the fix, iPhone (2800 steps) + Apple Watch (3000 steps) raw
      // samples would sum to 5800. With statistics, only one deduplicated
      // total (3000) is sent.
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 3000,
          startDate: "2024-01-15T12:00:00Z",
          endDate: "2024-01-15T12:00:00Z",
          uuid: "stat:steps:2024-01-15",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.steps).toBe(3000);
    });

    it("rounds float steps to integer before inserting into daily_metrics", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5552.349998360692,
            uuid: "steps-float",
          }),
        ],
      });

      // Find the daily_metrics INSERT
      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics");
      });
      expect(dailyInsertCall).toBeDefined();
      // The serialized SQL should contain the rounded integer value (5552), not the float
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      expect(serialized).toContain("5552");
      expect(serialized).not.toContain("5552.349998360692");
    });

    it("rounds float heart rate before inserting into sensor_sample", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 80.89823150634766,
            uuid: "hr-float",
          }),
        ],
      });

      // Find the sensor_sample INSERT
      const metricInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("fitness.sensor_sample") && serialized.includes("heart_rate");
      });
      expect(metricInsertCall).toBeDefined();
      const serialized = JSON.stringify(metricInsertCall?.[0]);
      expect(serialized).toContain("81");
      expect(serialized).not.toContain("80.89823150634766");
    });

    it("does not round real-valued columns (active_energy_kcal, distance_km)", async () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          value: 385.08851139373337,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "energy-float",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      // activeEnergyKcal is a real column — should preserve the float value
      expect(jan15?.activeEnergyKcal).toBeCloseTo(385.089, 2);
    });

    it("processes point-in-time daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierRestingHeartRate", value: 55, uuid: "rhr1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 65,
            uuid: "hrv1",
          }),
        ],
      });

      expect(result.inserted).toBe(2);
    });

    it("processes metric stream samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 120, uuid: "hr1" }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("links newly inserted heart-rate metric rows to existing workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 130, uuid: "hr-link-1" }),
        ],
      });

      const linkCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("UPDATE fitness.sensor_sample ss") &&
          serialized.includes("SET activity_id")
        );
      });
      expect(linkCall).toBeDefined();
    });

    it("processes health event samples (catch-all)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierUnknownType", value: 1, uuid: "he1" }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty samples array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({ samples: [] });

      expect(result.inserted).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("applies body fat percentage transform", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.15,
            uuid: "bf1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("refreshes v_daily_metrics materialized view after processing skin temp samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 34.5,
            unit: "degC",
            uuid: "skin-temp-1",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeDefined();
    });

    it("refreshes v_daily_metrics after processing SpO2 samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            unit: "%",
            uuid: "spo2-1",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeDefined();
    });

    it("refreshes v_daily_metrics when daily metric samples are inserted", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "steps-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeDefined();
    });

    it("does not refresh v_daily_metrics when no daily metrics or metric stream samples present", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
            value: 70,
            uuid: "audio-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("reports errors when processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // body measurements fail
      execute.mockRejectedValueOnce(new Error("DB connection failed"));

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierBodyMass", value: 75, uuid: "err1" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Body measurements");
    });

    it("reports errors when metric stream processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // metric_stream insert fails
      execute.mockRejectedValueOnce(new Error("Metric stream DB error"));

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 72, uuid: "hr-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Metric stream"))).toBe(true);
    });

    it("reports errors when daily metrics processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // daily metrics insert fails
      execute.mockRejectedValueOnce(new Error("Daily metrics DB error"));

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "dm-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Daily metrics"))).toBe(true);
    });

    it("reports errors when health event processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // health_event insert fails
      execute.mockRejectedValueOnce(new Error("Health event DB error"));

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierUnknownType", value: 1, uuid: "he-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Health events"))).toBe(true);
    });

    it("applies distance transform (m to km)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "dist1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("emits HealthKit metrics with per-category counts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierBodyMass", value: 75, uuid: "bm1" }),
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "dm1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            uuid: "ms1",
          }),
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "bodyMeasurement",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "dailyMetric",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "metricStream",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(0, {
        endpoint: "pushQuantitySamples",
        category: "healthEvent",
      });
    });
  });

  describe("pushWorkouts", () => {
    it("processes workout samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w1",
            workoutType: "13", // cycling
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("links existing heart-rate metric rows after workout upsert", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w-link",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      const linkCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("UPDATE fitness.sensor_sample ss") &&
          serialized.includes("SET activity_id")
        );
      });
      expect(linkCall).toBeDefined();
    });

    it("maps unknown workout type to other", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w2",
            workoutType: "999",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T10:30:00Z",
            duration: 1800,
            totalEnergyBurned: null,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty workouts array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({ workouts: [] });
      expect(result.inserted).toBe(0);
    });

    it("emits HealthKit metrics for workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w-metric",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushWorkouts",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushWorkouts",
        category: "workout",
      });
    });
  });

  describe("pushSleepSamples", () => {
    it("processes sleep session with stages", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-1",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-1",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-15T23:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-2",
            startDate: "2024-01-15T23:30:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-3",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T04:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-4",
            startDate: "2024-01-16T04:00:00Z",
            endDate: "2024-01-16T04:15:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);

      // Verify the computed stage minutes in the INSERT SQL
      // deep: 22:30-23:30 = 60, REM: 23:30-01:00 = 90,
      // light (core): 01:00-04:00 = 180, awake: 04:00-04:15 = 15
      const insertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
      const sqlValues = JSON.stringify(insertCall?.[0]);
      // Stage minutes appear as query parameter values in order:
      // deep_minutes, rem_minutes, light_minutes, awake_minutes
      expect(sqlValues).toContain(",60,"); // deep_minutes = 60
      expect(sqlValues).toContain(",90,"); // rem_minutes = 90
      expect(sqlValues).toContain(",180,"); // light_minutes = 180
      expect(sqlValues).toContain(",15,"); // awake_minutes = 15
    });

    it("includes duration_minutes and sleep_type in SQL", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-dur",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // 8 hours = 480 minutes
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      // Find the sleep INSERT call (not the ensureProvider or DELETE call)
      const sleepCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepCall).toBeDefined();
      const serialized = JSON.stringify(sleepCall?.[0]);
      expect(serialized).toContain("duration_minutes");
      expect(serialized).toContain("sleep_type");
    });

    it("stores null sleep_type for short sessions", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "nap-1",
            startDate: "2024-01-15T14:00:00Z",
            endDate: "2024-01-15T14:45:00Z", // 45 minutes — nap
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      // HealthKit has no native nap flag; raw sleep_type is stored as null.
      const sleepCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepCall).toBeDefined();
      const serialized = JSON.stringify(sleepCall?.[0]);
      expect(serialized).toContain("sleep_type");
    });

    it("stores per-source rows for multi-source data (dedup at query time)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          // iPhone writes inBed + asleep (unspecified)
          {
            uuid: "iphone-inbed",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "iPhone",
          },
          {
            uuid: "iphone-asleep",
            startDate: "2024-01-15T22:20:00Z",
            endDate: "2024-01-16T05:50:00Z",
            value: "asleep",
            sourceName: "iPhone",
          },
          // Apple Watch writes granular stages
          {
            uuid: "watch-core",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-deep",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T02:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-rem",
            startDate: "2024-01-16T02:30:00Z",
            endDate: "2024-01-16T04:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-core-2",
            startDate: "2024-01-16T04:00:00Z",
            endDate: "2024-01-16T05:30:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-awake",
            startDate: "2024-01-16T05:30:00Z",
            endDate: "2024-01-16T05:45:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      // Should insert 2 rows — one per source. The v_sleep view handles dedup.
      expect(result.inserted).toBe(2);

      // Both sources should have INSERT calls with source-specific external_ids
      const insertCalls = execute.mock.calls.filter((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(insertCalls).toHaveLength(2);
    });

    it("derives a sleep session when only stage samples are present", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "stage-only-1",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-2",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-3",
            startDate: "2024-01-16T02:00:00Z",
            endDate: "2024-01-16T05:00:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("emits HealthKit metrics for sleep samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-metric",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushSleepSamples",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushSleepSamples",
        category: "sleep",
      });
    });

    it("refreshes v_sleep materialized view after inserting sleep data", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-refresh",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_sleep");
      });
      expect(refreshCall).toBeDefined();
    });

    it("falls back to non-concurrent refresh when CONCURRENTLY fails", async () => {
      let callCount = 0;
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("CONCURRENTLY") && serialized.includes("v_sleep")) {
          callCount++;
          if (callCount === 1) throw new Error("has not been populated");
        }
        return Promise.resolve([]);
      });
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-fallback",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      // Should have called non-concurrent refresh as fallback
      const fallbackCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") &&
          serialized.includes("v_sleep") &&
          !serialized.includes("CONCURRENTLY")
        );
      });
      expect(fallbackCall).toBeDefined();
    });

    it("continues when view refresh fails entirely", async () => {
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("REFRESH MATERIALIZED VIEW")) {
          throw new Error("database unavailable");
        }
        return Promise.resolve([]);
      });
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // Should not throw — error is caught and logged
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-error",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });
      expect(result.inserted).toBe(1);
    });
  });

  describe("pushWorkouts view refresh", () => {
    it("refreshes v_activity and activity_summary after inserting workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "workout-refresh",
            workoutType: "13",
            startDate: "2024-01-15T09:00:00Z",
            endDate: "2024-01-15T10:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      const activityRefreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_activity")
        );
      });
      expect(activityRefreshCall).toBeDefined();

      const summaryRefreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") &&
          serialized.includes("activity_summary")
        );
      });
      expect(summaryRefreshCall).toBeDefined();
    });
  });

  describe("computeBoundsFromIsoTimestamps", () => {
    it("returns null for empty array", () => {
      expect(computeBoundsFromIsoTimestamps([])).toBeNull();
    });

    it("returns bounds for a single timestamp", () => {
      const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
      expect(result).toEqual({
        startAt: "2024-01-15T10:00:00.000Z",
        endAt: "2024-01-15T10:00:00.000Z",
      });
    });

    it("returns min/max bounds for multiple timestamps", () => {
      // Max is NOT the last element — kills `if (true) maxTs = ms` mutation
      // Min is NOT the last element — kills `if (true) minTs = ms` mutation
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T12:00:00Z",
        "2024-01-15T20:00:00Z",
        "2024-01-15T08:00:00Z",
      ]);
      expect(result).toEqual({
        startAt: "2024-01-15T08:00:00.000Z",
        endAt: "2024-01-15T20:00:00.000Z",
      });
    });

    it("returns null when only one of min/max is valid", () => {
      // Only one valid timestamp means both min and max are set —
      // but if the || is mutated to &&, it would incorrectly succeed when only one is invalid
      // This test kills `|| → &&` mutation on the isFinite check
      const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
      expect(result).not.toBeNull();
      // With a single valid ts, both min and max should be the same
      expect(result?.startAt).toBe(result?.endAt);
    });

    it("returns null when all timestamps are invalid", () => {
      expect(computeBoundsFromIsoTimestamps(["invalid", "also-invalid"])).toBeNull();
    });

    it("ignores invalid timestamps among valid ones", () => {
      const result = computeBoundsFromIsoTimestamps([
        "invalid",
        "2024-01-15T10:00:00Z",
        "2024-01-15T14:00:00Z",
      ]);
      expect(result).toEqual({
        startAt: "2024-01-15T10:00:00.000Z",
        endAt: "2024-01-15T14:00:00.000Z",
      });
    });
  });

  describe("deriveSleepSessionsFromStages", () => {
    function makeSleepSample(overrides: Partial<SleepSample> = {}): SleepSample {
      return {
        uuid: overrides.uuid ?? "sleep-1",
        startDate: overrides.startDate ?? "2024-01-15T23:00:00Z",
        endDate: overrides.endDate ?? "2024-01-15T23:30:00Z",
        value: overrides.value ?? "asleepCore",
        sourceName: overrides.sourceName ?? "Apple Watch",
      };
    }

    it("returns empty array for empty input", () => {
      expect(deriveSleepSessionsFromStages([])).toEqual([]);
    });

    it("returns empty array when no sleep stages present (only non-sleep values)", () => {
      const samples = [makeSleepSample({ value: "inBed", uuid: "s1" })];
      // "inBed" is not a sleep stage and not "awake", so it gets filtered out
      expect(deriveSleepSessionsFromStages(samples)).toEqual([]);
    });

    it("derives a single session from contiguous sleep stages", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T00:00:00.000Z");
      expect(result[0]?.value).toBe("inBed");
    });

    it("splits into two sessions when gap exceeds 90 minutes", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // 3-hour gap (> 90min threshold)
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      expect(result[0]?.endDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[1]?.startDate).toBe("2024-01-16T02:00:00.000Z");
    });

    it("merges stages within 90-minute gap", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        // 60-minute gap (< 90min threshold)
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T01:00:00Z",
          endDate: "2024-01-16T02:00:00Z",
          value: "asleepREM",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T02:00:00.000Z");
    });

    it("includes awake stages in session grouping", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T00:15:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s3",
          startDate: "2024-01-16T00:15:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("drops session that only contains awake stages (no actual sleep)", () => {
      // A session with only awake stages has currentHasSleepStage = false
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("filters out entries where endDate <= startDate", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-15T23:00:00Z", // end before start
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("filters out entries with invalid timestamps", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "invalid",
          endDate: "2024-01-15T23:30:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("sorts unsorted stages by start time before merging", () => {
      const samples = [
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session starts at the earliest stage, not the first in input order
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
      // UUID should be from the earliest stage (after sorting)
      expect(result[0]?.uuid).toBe("s1");
    });

    it("extends session end time when overlapping stage has later end", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:30:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z", // extends past s1 end
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("does not shrink session end time when overlapping stage has earlier end", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:30:00Z", // ends before s1
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // End should stay at s1's later end
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("does not emit session when gap occurs and first chunk has no sleep stage", () => {
      // First chunk: only awake (no sleep stage), then gap, then real sleep
      // Should only emit the second session, not the awake-only first chunk
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T20:00:00Z",
          endDate: "2024-01-15T21:00:00Z",
          value: "awake",
        }),
        // >90min gap
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("s2");
    });

    it("marks session as having sleep stage when later entry adds one", () => {
      // First entry is awake, second is actual sleep stage — session should be emitted
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session should span full range
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T00:00:00.000Z");
    });

    it("uses correct uuid from first entry after gap (new session start)", () => {
      const samples = [
        makeSleepSample({
          uuid: "first-session",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // >90min gap
        makeSleepSample({
          uuid: "second-session",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result[0]?.uuid).toBe("first-session");
      expect(result[1]?.uuid).toBe("second-session");
    });

    it("handles entry at exact gap boundary (90 minutes)", () => {
      const baseEnd = "2024-01-16T00:00:00Z";
      // Exactly 90 minutes later = within gap threshold (<=)
      const nextStart = "2024-01-16T01:30:00Z";

      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: baseEnd,
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: nextStart,
          endDate: "2024-01-16T02:30:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      // 90min gap is <= MAX_SLEEP_SESSION_GAP_MS (90min), so they merge
      expect(result).toHaveLength(1);
    });

    it("splits when gap exceeds boundary by 1ms", () => {
      const baseEnd = "2024-01-16T00:00:00Z";
      // 90 minutes + 1ms later — just over the threshold
      const nextStart = "2024-01-16T01:30:00.001Z";

      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: baseEnd,
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: nextStart,
          endDate: "2024-01-16T02:30:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      // Just over threshold — should split
      expect(result).toHaveLength(2);
    });

    it("loop index starts at 1 (second entry), not 0", () => {
      // Single entry should produce one session without loop iterations
      const samples = [
        makeSleepSample({
          uuid: "only",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("only");
    });

    it("groups by source name independently", () => {
      const samples = [
        makeSleepSample({
          uuid: "w1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepCore",
          sourceName: "Apple Watch",
        }),
        makeSleepSample({
          uuid: "p1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepDeep",
          sourceName: "iPhone",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      const sources = result.map((s) => s.sourceName).sort();
      expect(sources).toEqual(["Apple Watch", "iPhone"]);
    });
  });

  describe("isSleepStageValue", () => {
    it("returns true for all sleep stage values", () => {
      expect(isSleepStageValue("asleep")).toBe(true);
      expect(isSleepStageValue("asleepUnspecified")).toBe(true);
      expect(isSleepStageValue("asleepCore")).toBe(true);
      expect(isSleepStageValue("asleepDeep")).toBe(true);
      expect(isSleepStageValue("asleepREM")).toBe(true);
    });

    it("returns false for non-sleep-stage values", () => {
      expect(isSleepStageValue("inBed")).toBe(false);
      expect(isSleepStageValue("awake")).toBe(false);
      expect(isSleepStageValue("")).toBe(false);
      expect(isSleepStageValue("unknown")).toBe(false);
    });
  });

  describe("computeBoundsFromIsoTimestamps - mutation killers", () => {
    it("returns null when empty array (kills if(false) mutation on length===0 check)", () => {
      const result = computeBoundsFromIsoTimestamps([]);
      expect(result).toBeNull();
    });

    it("correctly identifies min and max from three unsorted timestamps (kills < to <= and > to >= mutations)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T12:00:00Z",
        "2024-01-15T08:00:00Z", // min
        "2024-01-15T20:00:00Z", // max
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe("2024-01-15T08:00:00.000Z");
      expect(result?.endAt).toBe("2024-01-15T20:00:00.000Z");
    });

    it("returns null when all timestamps are invalid (kills || to && mutation on isFinite check)", () => {
      const result = computeBoundsFromIsoTimestamps(["not-a-date", "also-not-a-date"]);
      expect(result).toBeNull();
    });

    it("skips NaN timestamps and still returns bounds from valid ones (kills if(false) on isNaN check)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "invalid-timestamp",
        "2024-06-01T10:00:00Z",
        "another-invalid",
        "2024-06-01T14:00:00Z",
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe("2024-06-01T10:00:00.000Z");
      expect(result?.endAt).toBe("2024-06-01T14:00:00.000Z");
    });

    it("handles duplicate timestamps correctly (kills <= / >= boundary mutations)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T10:00:00Z",
        "2024-01-15T10:00:00Z",
        "2024-01-15T10:00:00Z",
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe(result?.endAt);
    });
  });

  describe("aggregateDailyMetricSamples - mutation killers", () => {
    it("accumulates additive values and applies transforms correctly (kills ObjectLiteral mutations on additiveFields)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 5000,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "steps-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierActiveEnergyBurned",
          value: 300,
          startDate: "2024-01-15T11:00:00Z",
          uuid: "energy-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierBasalEnergyBurned",
          value: 1500,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "basal-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
          value: 5000, // meters, should be transformed to 5 km
          startDate: "2024-01-15T12:00:00Z",
          uuid: "dist-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierDistanceCycling",
          value: 20000, // meters, should be transformed to 20 km
          startDate: "2024-01-15T12:00:00Z",
          uuid: "cycle-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierFlightsClimbed",
          value: 12,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "flights-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierAppleExerciseTime",
          value: 45,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "exercise-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.steps).toBe(5000);
      expect(jan15?.activeEnergyKcal).toBe(300);
      expect(jan15?.basalEnergyKcal).toBe(1500);
      expect(jan15?.distanceKm).toBe(5);
      expect(jan15?.cyclingDistanceKm).toBe(20);
      expect(jan15?.flightsClimbed).toBe(12);
      expect(jan15?.exerciseMinutes).toBe(45);
    });

    it("sets point-in-time daily metrics correctly (kills if(key){} block removal, if(true)/if(false) mutations)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierRestingHeartRate",
          value: 55,
          startDate: "2024-01-15T08:00:00Z",
          uuid: "rhr-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierVO2Max",
          value: 42.5,
          startDate: "2024-01-15T09:00:00Z",
          uuid: "vo2-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingSpeed",
          value: 1.3,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "ws-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingStepLength",
          value: 0.72,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wsl-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
          value: 0.28,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wds-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
          value: 0.05,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wa-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.restingHr).toBe(55);
      expect(jan15?.vo2max).toBe(42.5);
      expect(jan15?.walkingSpeed).toBe(1.3);
      expect(jan15?.walkingStepLength).toBe(0.72);
      expect(jan15?.walkingDoubleSupportPct).toBe(0.28);
      expect(jan15?.walkingAsymmetryPct).toBe(0.05);
    });

    it("skips non-point, non-additive samples via continue (kills if(false) on !pointMapping continue)", () => {
      // A sample type that's only in metricStreamTypes (not in additive or point-in-time daily)
      // should be ignored by aggregateDailyMetricSamples
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRate", // this is in metricStreamTypes, not daily
          value: 72,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "hr-skip",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 100,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "steps-ok",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.steps).toBe(100);
      // Heart rate should not appear as any daily metric
      expect(jan15?.restingHr).toBeNull();
    });

    it("branches HRV samples into separate collection (kills if(true) on hrv column check)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 35,
          startDate: "2024-01-15T04:00:00Z",
          uuid: "hrv-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierRestingHeartRate",
          value: 60,
          startDate: "2024-01-15T06:00:00Z",
          uuid: "rhr-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.hrv).toBe(35);
      expect(jan15?.restingHr).toBe(60);
    });
  });

  describe("pushQuantitySamples - mutation killers for processDailyMetrics", () => {
    it("includes all additive fields in SQL when non-zero (kills ObjectLiteral {} mutations on field entries)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "s1",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierActiveEnergyBurned",
            value: 300,
            uuid: "s2",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierBasalEnergyBurned",
            value: 1500,
            uuid: "s3",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "s4",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierFlightsClimbed",
            value: 12,
            uuid: "s5",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierAppleExerciseTime",
            value: 45,
            uuid: "s6",
          }),
        ],
      });

      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      // Verify all additive columns are present in the SQL
      expect(serialized).toContain("steps");
      expect(serialized).toContain("active_energy_kcal");
      expect(serialized).toContain("basal_energy_kcal");
      expect(serialized).toContain("distance_km");
      expect(serialized).toContain("flights_climbed");
      expect(serialized).toContain("exercise_minutes");
    });

    it("includes all point-in-time fields in SQL when non-null (kills ObjectLiteral {} mutations on pointFields)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierRestingHeartRate",
            value: 55,
            uuid: "rhr-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 45,
            uuid: "hrv-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierVO2Max",
            value: 42,
            uuid: "vo2-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingSpeed",
            value: 1.3,
            uuid: "ws-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingStepLength",
            value: 0.72,
            uuid: "wsl-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
            value: 0.28,
            uuid: "wds-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
            value: 0.05,
            uuid: "wa-insert",
          }),
        ],
      });

      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      // Verify all point-in-time columns are present
      expect(serialized).toContain("resting_hr");
      expect(serialized).toContain("hrv");
      expect(serialized).toContain("vo2max");
      expect(serialized).toContain("walking_speed");
      expect(serialized).toContain("walking_step_length");
      expect(serialized).toContain("walking_double_support_pct");
      expect(serialized).toContain("walking_asymmetry_pct");
    });

    it("skips additive fields with zero value (kills raw > 0 to true/raw >= 0 mutations)", async () => {
      // If only zero-value additive fields are sent, the setClauses will be empty
      // and processDailyMetrics should skip the INSERT (continue on setClauses.length === 0)
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 0,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "zero-steps",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      // Steps should be 0 since value is 0
      expect(jan15?.steps).toBe(0);
    });

    it("properly categorizes pointInTimeDailyMetric types (kills if(false) mutation on categorize)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierVO2Max",
            value: 42,
            uuid: "vo2-categorize",
          }),
        ],
      });

      // Should insert (categorized as pointInTimeDailyMetric, processed by processDailyMetrics)
      expect(result.inserted).toBe(1);
    });

    it("reports errors when daily metrics processing fails (kills BlockStatement mutation on catch block)", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // daily_metrics insert fails
      execute.mockRejectedValueOnce(new Error("Daily metrics DB error"));

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "daily-err",
          }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((errorMsg: string) => errorMsg.includes("Daily metrics"))).toBe(
        true,
      );
    });
  });

  describe("pushQuantitySamples - mutation killers for metric stream aggregation", () => {
    it("initializes aggregatedDailyMetrics as false and only refreshes view when aggregation occurs (kills false to true mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // Send only HeartRate (metric stream type but not SpO2 or skin temp)
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            uuid: "hr-no-refresh",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      // No SpO2 or skin temp, so no aggregation, so no refresh
      expect(refreshCall).toBeUndefined();
    });

    it("handles concurrent refresh failure by falling back to non-concurrent refresh (kills catch{} empty block mutation)", async () => {
      const execute = vi.fn();
      execute.mockImplementation((..._args: unknown[]) => {
        // Make the CONCURRENTLY refresh fail to trigger the fallback
        const serialized = JSON.stringify(_args[0]);
        if (
          typeof serialized === "string" &&
          serialized.includes("REFRESH MATERIALIZED VIEW CONCURRENTLY")
        ) {
          return Promise.reject(new Error("cannot refresh concurrently"));
        }
        return Promise.resolve([]);
      });

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            uuid: "spo2-concurrent-fail",
          }),
        ],
      });

      // Should have attempted the non-concurrent refresh as fallback
      const nonConcurrentRefresh = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW fitness.v_daily_metrics") &&
          !serialized.includes("CONCURRENTLY")
        );
      });
      expect(nonConcurrentRefresh).toBeDefined();
    });

    it("correctly filters SpO2 samples using .some() not .every() (kills some to every mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // Mix of SpO2 and heart rate - .some() should return true, .every() would return false
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            uuid: "hr-mixed",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            uuid: "spo2-mixed",
          }),
        ],
      });

      // Aggregation should have happened because SpO2 is present (some returns true)
      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeDefined();
    });

    it("correctly filters skin temp samples (kills filter to identity mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // Only skin temp - should trigger aggregation
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 34.5,
            uuid: "skin-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeDefined();
    });
  });

  describe("pushWorkouts - mutation killers", () => {
    it("maps known workout type to correct activity type (kills ?? to && mutation on workoutActivityTypeMap)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w-cycling",
            workoutType: "13", // cycling
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      // Verify the SQL contains "cycling" as the activity type (not "other")
      const insertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("fitness.activity") && serialized.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
      const serialized = JSON.stringify(insertCall?.[0]);
      expect(serialized).toContain("cycling");
    });

    it("includes raw workout data in JSON (kills JSON.stringify({}) mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w-raw-data",
            workoutType: "35",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: 500,
            totalDistance: 10000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      const insertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("fitness.activity") && serialized.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
      const serialized = JSON.stringify(insertCall?.[0]);
      // Raw data should contain workout properties, not an empty object
      expect(serialized).toContain("3600"); // duration
      expect(serialized).toContain("500"); // totalEnergyBurned
      expect(serialized).toContain("10000"); // totalDistance
    });

    it("calls linkUnassignedHeartRateToWorkouts after processing workouts (kills if(true)/if(>=0) mutations on workouts.length > 0)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // With workouts, should call link
      await caller.pushWorkouts({
        workouts: [
          {
            uuid: "w-link-test",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalEnergyBurned: null,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      const linkCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("UPDATE fitness.sensor_sample ss") &&
          serialized.includes("SET activity_id")
        );
      });
      expect(linkCall).toBeDefined();
    });

    it("does not call linkUnassignedHeartRateToWorkouts when no workouts (kills workouts.length > 0 boundary)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({ workouts: [] });

      const linkCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("UPDATE fitness.sensor_sample ss") &&
          serialized.includes("SET activity_id")
        );
      });
      expect(linkCall).toBeUndefined();
    });
  });

  describe("pushSleepSamples - mutation killers", () => {
    it("filters inBed from stage samples (kills filter identity/true mutations on stageSamples)", async () => {
      const execute = vi.fn().mockImplementation((...args: unknown[]) => {
        const serialized = JSON.stringify(args[0]);
        // Return a session ID for the sleep_session INSERT so that stage insertion proceeds
        if (serialized.includes("sleep_session") && serialized.includes("RETURNING id")) {
          return Promise.resolve([{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }]);
        }
        return Promise.resolve([]);
      });
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // inBed session with stages where stage starts exactly at session start
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-filter",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-filter-1",
            startDate: "2024-01-15T22:00:00Z", // starts exactly at session start (>= check)
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-filter-2",
            startDate: "2024-01-16T02:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // ends exactly at session end (<= check)
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);

      // Verify the sleep stage INSERT happened (sessionId && stages.length > 0)
      const stageInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_stage") && serialized.includes("INSERT");
      });
      expect(stageInsert).toBeDefined();
    });

    it("calculates duration_minutes correctly (kills / to *, + to -, * to / arithmetic mutations)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "dur-test",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // 8 hours = 480 minutes
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // 480 minutes is the correct duration
      expect(serialized).toContain(",480,");
    });

    it("handles asleepUnspecified as light sleep (kills break removal and += to -= mutations)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-unspecified",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-unspecified",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-16T00:30:00Z", // 2 hours = 120 minutes
            value: "asleepUnspecified",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // light_minutes should be 120 (from asleepUnspecified), not 0 or -120
      expect(serialized).toContain(",120,");
    });

    it("handles inBed-only session with no stages (kills stagesBySource.size > 0 ArrayDeclaration mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-only",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // All stage minutes should be 0
      // The pattern should be deep=0, rem=0, light=0, awake=0
      expect(serialized).toContain(",0,");
    });

    it("filters out stages outside the inBed session (kills overlap check mutations >= to >, <= to <, && to ||)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-overlap",
            startDate: "2024-01-15T23:00:00Z",
            endDate: "2024-01-16T05:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          // Stage that starts BEFORE the session (should be filtered out by stageStart >= sessionStart)
          {
            uuid: "stage-before",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-15T22:30:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          // Stage that ends AFTER the session (should be filtered out by stageEnd <= sessionEnd)
          {
            uuid: "stage-after",
            startDate: "2024-01-16T04:30:00Z",
            endDate: "2024-01-16T05:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          // Stage within the session (should be included)
          {
            uuid: "stage-inside",
            startDate: "2024-01-16T00:00:00Z",
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // Only REM stage should be counted: 2 hours = 120 minutes
      // deep=0, rem=120, light=0, awake=0
      expect(serialized).toContain(",120,"); // rem_minutes
    });

    it("returns 0 when no inBed and no derivable sessions (kills if(false) on inBedSamples.length === 0)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      // Only non-sleep values that won't derive a session
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "non-sleep",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed", // inBed with no stages
            sourceName: "Apple Watch",
          },
        ],
      });

      // Should still insert 1 (the inBed session itself)
      expect(result.inserted).toBe(1);
    });

    it("cleans up legacy external IDs before inserting (verifies DELETE call)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-legacy",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const deleteCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("DELETE") && serialized.includes("sleep_session");
      });
      expect(deleteCall).toBeDefined();
    });
  });

  describe("deriveSleepSessionsFromStages - mutation killers", () => {
    function makeSleepSample(overrides: Partial<SleepSample> = {}): SleepSample {
      return {
        uuid: overrides.uuid ?? "sleep-1",
        startDate: overrides.startDate ?? "2024-01-15T23:00:00Z",
        endDate: overrides.endDate ?? "2024-01-15T23:30:00Z",
        value: overrides.value ?? "asleepCore",
        sourceName: overrides.sourceName ?? "Apple Watch",
      };
    }

    it("includes awake stages in filtering but not as sleep stage (kills && true / !== to === mutations on awake filter)", () => {
      // "awake" should pass the filter (it's explicitly checked) but not set currentHasSleepStage
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T01:00:00Z",
          endDate: "2024-01-16T01:15:00Z",
          value: "awake",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session should extend to include the awake segment
      expect(result[0]?.endDate).toBe("2024-01-16T01:15:00.000Z");
    });

    it("filters zero-duration entries where startDate equals endDate (kills > to >= mutation on endMs > startMs)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:00:00Z", // zero duration: endMs === startMs
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("handles entry with null endMs from invalid timestamp (kills || false mutation on endMs null check)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "invalid-date", // will produce null endMs
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("processes source with single sample correctly (kills firstEntry null checks)", () => {
      const samples = [
        makeSleepSample({
          uuid: "single",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("single");
      expect(result[0]?.sourceName).toBe("Apple Watch");
    });

    it("correctly handles loop bound (kills < to <= on sorted.length loop)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      // Should not crash even if loop goes one past the end
      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("sets currentHasSleepStage when subsequent entry is a sleep stage (kills isSleepStageValue check in loop)", () => {
      // First entry is awake (no sleep stage), second is asleepCore (sleep stage)
      // The session should still be emitted because the second entry sets currentHasSleepStage
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
    });

    it("uses uuid from session gap boundary correctly", () => {
      const samples = [
        makeSleepSample({
          uuid: "first-session",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // 3-hour gap
        makeSleepSample({
          uuid: "second-session",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      expect(result[0]?.uuid).toBe("first-session");
      expect(result[1]?.uuid).toBe("second-session");
    });
  });

  describe("pushQuantitySamples - metric stream JSON and batch mutations", () => {
    it("stores source metadata in sensor_sample columns", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            uuid: "hr-json-test",
            sourceName: "Apple Watch",
          }),
        ],
      });

      const metricInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("fitness.sensor_sample") && serialized.includes("INSERT");
      });
      expect(metricInsert).toBeDefined();
      const serialized = JSON.stringify(metricInsert?.[0]);
      expect(serialized).toContain("heart_rate");
      expect(serialized).toContain("Apple Watch");
    });
  });

  describe("pushQuantitySamples - body measurement mutations", () => {
    it("constructs proper external_id for body measurements (kills mapping continue on valid type)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "body-ext-id",
          }),
        ],
      });

      const bodyInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("body_measurement") && serialized.includes("INSERT");
      });
      expect(bodyInsert).toBeDefined();
      const serialized = JSON.stringify(bodyInsert?.[0]);
      expect(serialized).toContain("hk:body-ext-id");
    });

    it("processes BMI sample type (kills mapping guard)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMassIndex",
            value: 23.5,
            uuid: "bmi-1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      const bodyInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("body_measurement") && serialized.includes("bmi");
      });
      expect(bodyInsert).toBeDefined();
    });
  });

  describe("pushQuantitySamples - error status in metrics", () => {
    it("reports error status in healthKitPushTotal when errors exist", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]); // ensureProvider
      execute.mockRejectedValueOnce(new Error("fail")); // body measurement error

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "err-status",
          }),
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        status: "error",
      });
    });

    it("handles non-Error objects in catch blocks", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]); // ensureProvider
      execute.mockRejectedValueOnce("string error"); // non-Error rejection

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "non-error-obj",
          }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      // Should use String() conversion for non-Error objects
      expect(result.errors[0]).toContain("string error");
    });
  });
});
