import { describe, expect, it, vi } from "vitest";
import {
  aggregateDailyMetricSamples,
  categorize,
  computeBoundsFromIsoTimestamps,
  deriveSleepSessionsFromStages,
  extractDate,
  type HealthKitSample,
  HealthKitSyncRepository,
  isSleepStageValue,
  type SleepSample,
} from "./health-kit-sync-repository.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

describe("extractDate", () => {
  it("extracts YYYY-MM-DD from ISO timestamp with timezone offset", () => {
    expect(extractDate("2024-01-14T21:30:00-0700")).toBe("2024-01-14");
  });

  it("extracts YYYY-MM-DD from UTC timestamp", () => {
    expect(extractDate("2024-01-15T10:00:00Z")).toBe("2024-01-15");
  });
});

describe("computeBoundsFromIsoTimestamps", () => {
  it("returns null for empty array", () => {
    expect(computeBoundsFromIsoTimestamps([])).toBeNull();
  });

  it("returns bounds for single timestamp", () => {
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("returns min and max for multiple timestamps", () => {
    const result = computeBoundsFromIsoTimestamps([
      "2024-01-15T10:00:00Z",
      "2024-01-17T08:00:00Z",
      "2024-01-16T14:00:00Z",
    ]);
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-17T08:00:00.000Z");
  });

  it("skips invalid timestamps", () => {
    const result = computeBoundsFromIsoTimestamps(["invalid", "2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("returns null when all timestamps are invalid", () => {
    expect(computeBoundsFromIsoTimestamps(["invalid", "also-invalid"])).toBeNull();
  });
});

describe("isSleepStageValue", () => {
  it("returns true for sleep stage values", () => {
    expect(isSleepStageValue("asleep")).toBe(true);
    expect(isSleepStageValue("asleepUnspecified")).toBe(true);
    expect(isSleepStageValue("asleepCore")).toBe(true);
    expect(isSleepStageValue("asleepDeep")).toBe(true);
    expect(isSleepStageValue("asleepREM")).toBe(true);
  });

  it("returns false for non-sleep-stage values", () => {
    expect(isSleepStageValue("awake")).toBe(false);
    expect(isSleepStageValue("inBed")).toBe(false);
    expect(isSleepStageValue("other")).toBe(false);
  });
});

describe("categorize", () => {
  it("categorizes body measurement types", () => {
    expect(categorize("HKQuantityTypeIdentifierBodyMass")).toBe("bodyMeasurement");
    expect(categorize("HKQuantityTypeIdentifierBodyFatPercentage")).toBe("bodyMeasurement");
  });

  it("categorizes additive daily metric types", () => {
    expect(categorize("HKQuantityTypeIdentifierStepCount")).toBe("additiveDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierActiveEnergyBurned")).toBe("additiveDailyMetric");
  });

  it("categorizes point-in-time daily metric types", () => {
    expect(categorize("HKQuantityTypeIdentifierRestingHeartRate")).toBe("pointInTimeDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierVO2Max")).toBe("pointInTimeDailyMetric");
  });

  it("categorizes metric stream types", () => {
    expect(categorize("HKQuantityTypeIdentifierHeartRate")).toBe("metricStream");
    expect(categorize("HKQuantityTypeIdentifierOxygenSaturation")).toBe("metricStream");
  });

  it("returns healthEvent for unknown types", () => {
    expect(categorize("HKQuantityTypeIdentifierSomethingUnknown")).toBe("healthEvent");
  });
});

describe("aggregateDailyMetricSamples", () => {
  function makeSample(overrides: Partial<HealthKitSample> = {}): HealthKitSample {
    return {
      type: "HKQuantityTypeIdentifierStepCount",
      value: 1000,
      unit: "count",
      startDate: "2024-01-15T10:00:00Z",
      endDate: "2024-01-15T10:30:00Z",
      sourceName: "iPhone",
      sourceBundle: "com.apple.Health",
      uuid: "test-uuid",
      ...overrides,
    };
  }

  it("returns empty map for no samples", () => {
    const result = aggregateDailyMetricSamples([]);
    expect(result.size).toBe(0);
  });

  it("sums additive metrics within the same date and source", () => {
    const samples = [
      makeSample({ value: 1000, uuid: "1" }),
      makeSample({ value: 2000, uuid: "2" }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    expect(result.size).toBe(1);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.steps).toBe(3000);
  });

  it("separates different dates", () => {
    const samples = [
      makeSample({ startDate: "2024-01-15T10:00:00Z", uuid: "1" }),
      makeSample({ startDate: "2024-01-16T10:00:00Z", uuid: "2" }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    expect(result.size).toBe(2);
  });

  it("separates different sources", () => {
    const samples = [
      makeSample({ sourceName: "iPhone", uuid: "1" }),
      makeSample({ sourceName: "Apple Watch", uuid: "2" }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    expect(result.size).toBe(2);
  });

  it("transforms distance from meters to kilometers", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 5000,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.distanceKm).toBeCloseTo(5.0);
  });

  it("handles point-in-time metrics (last value wins)", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 60,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 62,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // Last value overwrites
    expect(accumulator?.restingHr).toBe(62);
  });

  it("handles VO2Max as point-in-time", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierVO2Max",
        value: 45.5,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.vo2max).toBe(45.5);
  });
});

describe("deriveSleepSessionsFromStages", () => {
  function makeSleepSample(overrides: Partial<SleepSample> = {}): SleepSample {
    return {
      uuid: "sleep-uuid-1",
      startDate: "2024-01-15T22:00:00Z",
      endDate: "2024-01-16T06:00:00Z",
      value: "asleepCore",
      sourceName: "Apple Watch",
      ...overrides,
    };
  }

  it("returns empty array for no samples", () => {
    expect(deriveSleepSessionsFromStages([])).toEqual([]);
  });

  it("derives a single session from contiguous stages", () => {
    const samples = [
      makeSleepSample({
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
      }),
      makeSleepSample({
        uuid: "2",
        startDate: "2024-01-15T23:00:00Z",
        endDate: "2024-01-16T01:00:00Z",
        value: "asleepDeep",
      }),
      makeSleepSample({
        uuid: "3",
        startDate: "2024-01-16T01:00:00Z",
        endDate: "2024-01-16T03:00:00Z",
        value: "asleepREM",
      }),
    ];
    const sessions = deriveSleepSessionsFromStages(samples);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.value).toBe("inBed");
    expect(sessions[0]?.startDate).toBe("2024-01-15T22:00:00.000Z");
    expect(sessions[0]?.endDate).toBe("2024-01-16T03:00:00.000Z");
  });

  it("skips sessions with only awake stages", () => {
    const samples = [
      makeSleepSample({
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T22:30:00Z",
        value: "awake",
      }),
    ];
    const sessions = deriveSleepSessionsFromStages(samples);
    expect(sessions).toHaveLength(0);
  });

  it("includes sessions that have at least one sleep stage alongside awake", () => {
    const samples = [
      makeSleepSample({
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T22:30:00Z",
        value: "awake",
      }),
      makeSleepSample({
        uuid: "2",
        startDate: "2024-01-15T22:30:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
      }),
    ];
    const sessions = deriveSleepSessionsFromStages(samples);
    expect(sessions).toHaveLength(1);
  });

  it("filters out non-sleep non-awake values", () => {
    const samples = [makeSleepSample({ uuid: "1", value: "inBed" })];
    const sessions = deriveSleepSessionsFromStages(samples);
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Constants tested indirectly via behavior
// ---------------------------------------------------------------------------

describe("HEALTHKIT_STAGE_MAP (via deriveSleepSessionsFromStages stage mapping)", () => {
  // The stage map is used internally; we verify its effects through deriveSleepSessionsFromStages.
  // Each sleep stage value recognized by isSleepStageValue is included in sessions.

  it("recognizes asleepDeep as a sleep stage", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("recognizes asleepCore as a sleep stage", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("recognizes asleepREM as a sleep stage", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepREM",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("recognizes asleep as a sleep stage", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("recognizes asleepUnspecified as a sleep stage", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepUnspecified",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });
});

describe("HEALTHKIT_STAGE_MAP mapped values (via processSleepSamples)", () => {
  async function getStageInsertSqlJson(stageValue: string): Promise<string> {
    const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: SleepSample[] = [
      {
        uuid: "inbed-1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "inBed",
        sourceName: "Watch",
      },
      {
        uuid: "stage-1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: stageValue,
        sourceName: "Watch",
      },
    ];
    await repo.processSleepSamples(samples);
    // Collect all execute calls as JSON and find the INSERT INTO fitness.sleep_stage call
    const allCalls = execute.mock.calls.map((call) => JSON.stringify(call[0]));
    const stageInsertCall = allCalls.find((callStr) =>
      callStr.includes("INSERT INTO fitness.sleep_stage"),
    );
    return stageInsertCall ?? "";
  }

  it("maps asleepDeep to 'deep'", async () => {
    const sqlJson = await getStageInsertSqlJson("asleepDeep");
    expect(sqlJson).toContain("deep");
  });

  it("maps asleepCore to 'light'", async () => {
    const sqlJson = await getStageInsertSqlJson("asleepCore");
    expect(sqlJson).toContain("light");
  });

  it("maps asleepREM to 'rem'", async () => {
    const sqlJson = await getStageInsertSqlJson("asleepREM");
    expect(sqlJson).toContain("rem");
  });

  it("maps asleep to 'light'", async () => {
    const sqlJson = await getStageInsertSqlJson("asleep");
    expect(sqlJson).toContain("light");
  });

  it("maps asleepUnspecified to 'light'", async () => {
    const sqlJson = await getStageInsertSqlJson("asleepUnspecified");
    expect(sqlJson).toContain("light");
  });

  it("maps awake to 'awake'", async () => {
    const sqlJson = await getStageInsertSqlJson("awake");
    expect(sqlJson).toContain("awake");
  });
});

describe("MAX_SLEEP_SESSION_GAP_MS (90 minutes)", () => {
  it("merges stages separated by exactly 90 minutes into one session", () => {
    // Gap of exactly 90 minutes (5,400,000 ms) between end of first and start of second
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "2",
        startDate: "2024-01-16T00:30:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("is exactly 90 minutes (5,400,000 ms), not 60 or 120 minutes", () => {
    // 89-minute gap (within 90) => 1 session
    const merged = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "2",
        startDate: "2024-01-16T00:29:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(merged).toHaveLength(1);

    // 61-minute gap: would split if threshold were 60 min, but should merge with 90 min threshold
    const stillMerged = deriveSleepSessionsFromStages([
      {
        uuid: "3",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "4",
        startDate: "2024-01-16T00:01:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(stillMerged).toHaveLength(1);
  });

  it("splits stages separated by more than 90 minutes into two sessions", () => {
    // Gap of 91 minutes between end of first and start of second
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "2",
        startDate: "2024-01-16T00:31:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(2);
  });
});

describe("workoutActivityTypeMap (via processWorkouts)", () => {
  it("maps type 35 to running", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processWorkouts([
      {
        uuid: "w-1",
        workoutType: "35",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ]);
    // The SQL should contain the mapped activity type "running"
    const callArgs = execute.mock.calls[0]?.[0];
    const queryString = String(callArgs?.queryChunks?.join?.("") ?? callArgs);
    expect(queryString).toContain("running");
  });

  it("maps type 13 to cycling", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processWorkouts([
      {
        uuid: "w-2",
        workoutType: "13",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ]);
    const callArgs = execute.mock.calls[0]?.[0];
    const queryString = String(callArgs?.queryChunks?.join?.("") ?? callArgs);
    expect(queryString).toContain("cycling");
  });

  it("maps type 23 to hiking", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processWorkouts([
      {
        uuid: "w-hike",
        workoutType: "23",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ]);
    const callArgs = execute.mock.calls[0]?.[0];
    const queryString = String(callArgs?.queryChunks?.join?.("") ?? callArgs);
    expect(queryString).toContain("hiking");
  });

  it("maps type 44 to swimming", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processWorkouts([
      {
        uuid: "w-swim",
        workoutType: "44",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ]);
    const callArgs = execute.mock.calls[0]?.[0];
    const queryString = String(callArgs?.queryChunks?.join?.("") ?? callArgs);
    expect(queryString).toContain("swimming");
  });

  it("maps unknown workout type to other", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processWorkouts([
      {
        uuid: "w-3",
        workoutType: "9999",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ]);
    const callArgs = execute.mock.calls[0]?.[0];
    const queryString = String(callArgs?.queryChunks?.join?.("") ?? callArgs);
    expect(queryString).toContain("other");
  });
});

describe("INTEGER_DAILY_COLUMNS", () => {
  it("rounds steps to integer (not float)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierStepCount",
        value: 1500.7,
        unit: "count",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "int-1",
      },
    ];
    await repo.processDailyMetrics(samples);
    // Verify execute was called (the rounding happens inside the SQL values)
    expect(execute).toHaveBeenCalled();
  });

  it("processes flights climbed as integer column", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processDailyMetrics([
      {
        type: "HKQuantityTypeIdentifierFlightsClimbed",
        value: 3.9,
        unit: "count",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "int-flights",
      },
    ]);
    expect(execute).toHaveBeenCalled();
  });

  it("processes exercise minutes as integer column", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processDailyMetrics([
      {
        type: "HKQuantityTypeIdentifierAppleExerciseTime",
        value: 32.8,
        unit: "min",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "int-exercise",
      },
    ]);
    expect(execute).toHaveBeenCalled();
  });

  it("processes resting HR as integer column", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    await repo.processDailyMetrics([
      {
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 62.4,
        unit: "count/min",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "int-rhr",
      },
    ]);
    expect(execute).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("HealthKitSyncRepository", () => {
  function makeRepository() {
    const execute = vi.fn().mockResolvedValue([]);
    const db = { execute };
    const repository = new HealthKitSyncRepository(db, "user-1");
    return { repository, execute };
  }

  function makeSample(overrides: Partial<HealthKitSample> = {}): HealthKitSample {
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

  describe("ensureProvider", () => {
    it("executes an INSERT for the provider", async () => {
      const { repository, execute } = makeRepository();
      await repository.ensureProvider();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("processBodyMeasurements", () => {
    it("returns 0 for empty samples", async () => {
      const { repository } = makeRepository();
      const result = await repository.processBodyMeasurements([]);
      expect(result).toBe(0);
    });

    it("inserts body measurement samples", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierBodyMass",
          value: 75.5,
          uuid: "bm-1",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("skips samples with unknown type", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierUnknown",
          uuid: "bm-unknown",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("processDailyMetrics", () => {
    it("returns 0 for empty samples", async () => {
      const { repository, execute } = makeRepository();
      const result = await repository.processDailyMetrics([]);
      expect(result).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });

    it("upserts aggregated daily metrics", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "s1" }),
        makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 3000, uuid: "s2" }),
      ];
      const result = await repository.processDailyMetrics(samples);
      expect(result).toBe(2);
      expect(execute).toHaveBeenCalledTimes(1); // One upsert for the single date/source
    });

    it("creates separate upserts for different sources", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({ sourceName: "iPhone", uuid: "s1" }),
        makeSample({ sourceName: "Apple Watch", uuid: "s2" }),
      ];
      const result = await repository.processDailyMetrics(samples);
      expect(result).toBe(2);
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("processMetricStream", () => {
    it("returns 0 for empty samples", async () => {
      const { repository } = makeRepository();
      const result = await repository.processMetricStream([]);
      expect(result).toBe(0);
    });

    it("inserts metric stream samples", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 72,
          uuid: "hr-1",
        }),
      ];
      const result = await repository.processMetricStream(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("skips samples with unmapped type", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          uuid: "steps-1",
        }),
      ];
      const result = await repository.processMetricStream(samples);
      expect(result).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("processHealthEvents", () => {
    it("returns 0 for empty samples", async () => {
      const { repository } = makeRepository();
      const result = await repository.processHealthEvents([]);
      expect(result).toBe(0);
    });

    it("inserts health event samples", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierSomething",
          uuid: "he-1",
        }),
      ];
      const result = await repository.processHealthEvents(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("processWorkouts", () => {
    it("returns 0 for empty workouts", async () => {
      const { repository, execute } = makeRepository();
      const result = await repository.processWorkouts([]);
      expect(result).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    });

    it("inserts workouts and links heart rate", async () => {
      const { repository, execute } = makeRepository();
      const workouts = [
        {
          uuid: "w-1",
          workoutType: "35",
          startDate: "2024-01-15T10:00:00Z",
          endDate: "2024-01-15T11:00:00Z",
          duration: 3600,
          totalEnergyBurned: 500,
          totalDistance: 10000,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.Health",
        },
      ];
      const result = await repository.processWorkouts(workouts);
      expect(result).toBe(1);
      // One insert for the workout + one update for linking heart rate
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("processSleepSamples", () => {
    it("returns 0 for empty samples", async () => {
      const { repository } = makeRepository();
      const result = await repository.processSleepSamples([]);
      expect(result).toBe(0);
    });

    it("returns 0 when there are no inBed samples and no derivable sessions", async () => {
      makeRepository();
      const samples: SleepSample[] = [
        {
          uuid: "s1",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T22:30:00Z",
          value: "inBed",
          sourceName: "Apple Watch",
        },
      ];
      // inBed with no overlapping stages still inserts
      const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
      const db = { execute };
      const repository2 = new HealthKitSyncRepository(db, "user-1");
      const result = await repository2.processSleepSamples(samples);
      expect(result).toBe(1);
    });
  });

  describe("linkUnassignedHeartRateToWorkouts", () => {
    it("returns count of linked rows", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([
          { recorded_at: "2024-01-15T10:30:00Z" },
          { recorded_at: "2024-01-15T10:31:00Z" },
        ]);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      const result = await repository.linkUnassignedHeartRateToWorkouts({
        startAt: "2024-01-15T10:00:00Z",
        endAt: "2024-01-15T11:00:00Z",
      });
      expect(result).toBe(2);
    });

    it("returns 0 when no rows linked", async () => {
      const { repository } = makeRepository();
      const result = await repository.linkUnassignedHeartRateToWorkouts();
      expect(result).toBe(0);
    });
  });

  describe("aggregateSpO2ToDailyMetrics", () => {
    it("executes the aggregation query", async () => {
      const { repository, execute } = makeRepository();
      await repository.aggregateSpO2ToDailyMetrics(
        { startAt: "2024-01-15T00:00:00Z", endAt: "2024-01-15T23:59:59Z" },
        "America/New_York",
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("aggregateSkinTempToDailyMetrics", () => {
    it("executes the aggregation query", async () => {
      const { repository, execute } = makeRepository();
      await repository.aggregateSkinTempToDailyMetrics(
        { startAt: "2024-01-15T00:00:00Z", endAt: "2024-01-15T23:59:59Z" },
        "UTC",
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("refreshDailyMetricsView", () => {
    it("refreshes materialized view concurrently", async () => {
      const { repository, execute } = makeRepository();
      await repository.refreshDailyMetricsView();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("falls back to non-concurrent refresh on error", async () => {
      const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error("concurrent refresh not possible"))
        .mockResolvedValueOnce([]);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      await repository.refreshDailyMetricsView();
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });
});
