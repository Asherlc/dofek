import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { aggregateDailyMetricSamples, healthKitSyncRouter } from "./health-kit-sync.ts";

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
          serialized.includes("UPDATE fitness.metric_stream ms") &&
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

    it("does not refresh v_daily_metrics when no metric stream samples present", async () => {
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
          serialized.includes("UPDATE fitness.metric_stream ms") &&
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
  });
});
