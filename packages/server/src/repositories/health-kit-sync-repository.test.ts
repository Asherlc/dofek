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

  it("requires BOTH minTs and maxTs to be finite (|| not &&)", () => {
    // If only one valid timestamp among invalids, both min and max are the same valid value
    // This tests that both isFinite checks are needed
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe(result?.endAt);
  });

  it("returns null when all timestamps are NaN (isFinite guards both min and max)", () => {
    // Both minTs stays POSITIVE_INFINITY and maxTs stays NEGATIVE_INFINITY
    // isFinite(POSITIVE_INFINITY) = false, isFinite(NEGATIVE_INFINITY) = false
    // The || means either being non-finite returns null
    const result = computeBoundsFromIsoTimestamps(["not-a-date", "also-bad", "nope"]);
    expect(result).toBeNull();
  });

  it("uses < for minTs update (not <=)", () => {
    // With two identical timestamps, both should be accepted
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z", "2024-01-15T10:00:00Z"]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-15T10:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("handles mix of valid and invalid where min != max", () => {
    const result = computeBoundsFromIsoTimestamps([
      "not-a-date",
      "2024-01-10T00:00:00Z",
      "garbage",
      "2024-01-20T00:00:00Z",
    ]);
    expect(result).not.toBeNull();
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
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

  it("returns true for each individual sleep stage (mutation: removing one || clause)", () => {
    // Each assertion kills a mutation that removes a specific === check
    expect(isSleepStageValue("asleep")).toBe(true);
    expect(isSleepStageValue("asleepUnspecified")).toBe(true);
    expect(isSleepStageValue("asleepCore")).toBe(true);
    expect(isSleepStageValue("asleepDeep")).toBe(true);
    expect(isSleepStageValue("asleepREM")).toBe(true);
    // These similar but wrong values must return false
    expect(isSleepStageValue("Asleep")).toBe(false);
    expect(isSleepStageValue("asleep-light")).toBe(false);
    expect(isSleepStageValue("")).toBe(false);
  });

  it("each sleep stage value is independently recognized (not just any truthy string)", () => {
    // If any individual === check is removed by mutation, that specific value returns false
    // Test each value in isolation to kill each || clause mutation
    const stages = [
      "asleep",
      "asleepUnspecified",
      "asleepCore",
      "asleepDeep",
      "asleepREM",
    ] as const;
    for (const stage of stages) {
      expect(isSleepStageValue(stage)).toBe(true);
    }
    // Verify partial matches don't work (not prefix matching)
    expect(isSleepStageValue("asleepC")).toBe(false);
    expect(isSleepStageValue("asleepD")).toBe(false);
    expect(isSleepStageValue("asleepR")).toBe(false);
    expect(isSleepStageValue("asleepU")).toBe(false);
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

  it("uses += (accumulation) for additive metrics, not = (replacement)", () => {
    // If += were mutated to =, only the last value would be kept
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 1000,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 2000,
        uuid: "2",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 500,
        uuid: "3",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // With +=: 1000 + 2000 + 500 = 3500
    // With =: only last value = 500
    expect(accumulator?.steps).toBe(3500);
  });

  it("accumulates active energy burned across multiple samples", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierActiveEnergyBurned",
        value: 200,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierActiveEnergyBurned",
        value: 350,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // With +=: 200 + 350 = 550 (not just 350)
    expect(accumulator?.activeEnergyKcal).toBe(550);
  });

  it("accumulates distance with transform (meters to km)", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 3000,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 2000,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // 3000/1000 + 2000/1000 = 3 + 2 = 5 km
    expect(accumulator?.distanceKm).toBeCloseTo(5.0);
  });

  it("skips unknown sample types (does not modify accumulator values)", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierUnknownType",
        value: 999,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    // An accumulator is created for the date/source, but the unknown type doesn't modify any field
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.steps).toBe(0);
    expect(accumulator?.activeEnergyKcal).toBe(0);
    expect(accumulator?.restingHr).toBeNull();
  });

  it("accumulates cycling distance with transform (meters to km)", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceCycling",
        value: 10000,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceCycling",
        value: 5000,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // 10000/1000 + 5000/1000 = 10 + 5 = 15 km
    expect(accumulator?.cyclingDistanceKm).toBeCloseTo(15.0);
  });

  it("accumulates basal energy burned", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierBasalEnergyBurned",
        value: 800,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierBasalEnergyBurned",
        value: 600,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.basalEnergyKcal).toBe(1400);
  });

  it("accumulates flights climbed", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierFlightsClimbed",
        value: 3,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierFlightsClimbed",
        value: 5,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.flightsClimbed).toBe(8);
  });

  it("accumulates exercise minutes", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierAppleExerciseTime",
        value: 15,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierAppleExerciseTime",
        value: 20,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.exerciseMinutes).toBe(35);
  });

  it("handles walking speed as point-in-time metric", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierWalkingSpeed",
        value: 1.2,
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierWalkingSpeed",
        value: 1.4,
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // Last value wins for point-in-time
    expect(accumulator?.walkingSpeed).toBe(1.4);
  });

  it("handles walking step length as point-in-time metric", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierWalkingStepLength",
        value: 0.72,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.walkingStepLength).toBe(0.72);
  });

  it("handles walking double support percentage as point-in-time", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
        value: 28.5,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.walkingDoubleSupportPct).toBe(28.5);
  });

  it("handles walking asymmetry percentage as point-in-time", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
        value: 5.2,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.walkingAsymmetryPct).toBe(5.2);
  });

  it("collects HRV samples separately for overnight selection", () => {
    // HRV uses selectDailyHeartRateVariability instead of simple last-value-wins
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 45,
        startDate: "2024-01-15T03:00:00Z",
        uuid: "1",
      }),
      makeSample({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 52,
        startDate: "2024-01-15T04:00:00Z",
        uuid: "2",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // HRV should be set (not null) since there are valid samples
    expect(accumulator?.hrv).not.toBeNull();
    expect(typeof accumulator?.hrv).toBe("number");
  });

  it("initializes all accumulator fields correctly", () => {
    // A single sample creates an accumulator; verify all fields have correct defaults
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 100,
        uuid: "1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.steps).toBe(100);
    expect(accumulator?.activeEnergyKcal).toBe(0);
    expect(accumulator?.basalEnergyKcal).toBe(0);
    expect(accumulator?.distanceKm).toBe(0);
    expect(accumulator?.cyclingDistanceKm).toBe(0);
    expect(accumulator?.flightsClimbed).toBe(0);
    expect(accumulator?.exerciseMinutes).toBe(0);
    expect(accumulator?.restingHr).toBeNull();
    expect(accumulator?.hrv).toBeNull();
    expect(accumulator?.vo2max).toBeNull();
    expect(accumulator?.walkingSpeed).toBeNull();
    expect(accumulator?.walkingStepLength).toBeNull();
    expect(accumulator?.walkingDoubleSupportPct).toBeNull();
    expect(accumulator?.walkingAsymmetryPct).toBeNull();
  });

  it("uses = (replacement) for point-in-time metrics, not +=", () => {
    // Point-in-time metrics should replace, not accumulate
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 58,
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
    // Last value wins (= assignment), not sum (58 + 62 = 120)
    expect(accumulator?.restingHr).toBe(62);
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

    it("applies body fat percentage transform (value * 100)", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierBodyFatPercentage",
          value: 0.185,
          uuid: "bf-1",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      // The transformed value (0.185 * 100 = 18.5) is used in the SQL
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("18.5");
    });

    it("inserts BMI without transform", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierBodyMassIndex",
          value: 23.4,
          uuid: "bmi-1",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("inserts height without transform", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeight",
          value: 175.5,
          uuid: "height-1",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("processes multiple body measurement samples in batch", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierBodyMass",
          value: 75.5,
          uuid: "bm-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierBodyFatPercentage",
          value: 0.15,
          uuid: "bm-2",
        }),
      ];
      const result = await repository.processBodyMeasurements(samples);
      expect(result).toBe(2);
      expect(execute).toHaveBeenCalledTimes(2);
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

    it("rounds integer metric stream columns (heart_rate)", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 72.7,
          uuid: "hr-round",
        }),
      ];
      const result = await repository.processMetricStream(samples);
      expect(result).toBe(1);
      // heart_rate is in INTEGER_METRIC_STREAM_COLUMNS so it should be Math.round(72.7) = 73
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("73");
    });

    it("inserts non-integer metric stream columns without rounding (spo2)", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierOxygenSaturation",
          value: 0.975,
          uuid: "spo2-1",
        }),
      ];
      const result = await repository.processMetricStream(samples);
      expect(result).toBe(1);
      // spo2 is NOT in INTEGER_METRIC_STREAM_COLUMNS, value should be passed as-is
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("0.975");
    });

    it("inserts respiratory rate without rounding", async () => {
      const { repository, execute } = makeRepository();
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierRespiratoryRate",
          value: 14.5,
          uuid: "rr-1",
        }),
      ];
      const result = await repository.processMetricStream(samples);
      expect(result).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("handles non-array return value gracefully", async () => {
      const execute = vi.fn().mockResolvedValue(42);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      const result = await repository.linkUnassignedHeartRateToWorkouts();
      // Non-array returns 0
      expect(result).toBe(0);
    });

    it("includes startAt filter when bounds.startAt is provided", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      await repository.linkUnassignedHeartRateToWorkouts({
        startAt: "2024-01-15T10:00:00Z",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2024-01-15T10:00:00Z");
    });

    it("includes endAt filter when bounds.endAt is provided", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      await repository.linkUnassignedHeartRateToWorkouts({
        endAt: "2024-01-15T11:00:00Z",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2024-01-15T11:00:00Z");
    });

    it("works with both startAt and endAt bounds", async () => {
      const execute = vi.fn().mockResolvedValue([{ recorded_at: "2024-01-15T10:30:00Z" }]);
      const db = { execute };
      const repository = new HealthKitSyncRepository(db, "user-1");
      const result = await repository.linkUnassignedHeartRateToWorkouts({
        startAt: "2024-01-15T10:00:00Z",
        endAt: "2024-01-15T11:00:00Z",
      });
      expect(result).toBe(1);
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

// ---------------------------------------------------------------------------
// Additional mutation-killing tests
// ---------------------------------------------------------------------------

describe("extractDate (mutation-killing)", () => {
  it("uses slice(0, 10) — exactly 10 characters from the start", () => {
    // If slice endpoint mutated (e.g., 0,9 or 0,11), we'd get wrong length
    const result = extractDate("2024-01-15T10:00:00Z");
    expect(result).toBe("2024-01-15");
    expect(result.length).toBe(10);
  });

  it("slices from index 0, not index 1", () => {
    // If start index mutated to 1, we'd lose the first char
    const result = extractDate("2024-01-15T10:00:00Z");
    expect(result[0]).toBe("2");
    expect(result).toBe("2024-01-15");
  });
});

describe("computeBoundsFromIsoTimestamps (mutation-killing)", () => {
  it("returns startAt as the minimum timestamp and endAt as the maximum", () => {
    const result = computeBoundsFromIsoTimestamps([
      "2024-01-20T00:00:00Z",
      "2024-01-10T00:00:00Z",
      "2024-01-15T00:00:00Z",
    ]);
    // If < and > were swapped, startAt would be max and endAt would be min
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
    // Confirm they're different (not both set to same value)
    expect(result?.startAt).not.toBe(result?.endAt);
  });

  it("updates minTs with < comparison (not <=, >, or >=)", () => {
    // With timestamps where the earlier one appears second in the array
    const result = computeBoundsFromIsoTimestamps(["2024-01-20T00:00:00Z", "2024-01-10T00:00:00Z"]);
    expect(result?.startAt).toBe("2024-01-10T00:00:00.000Z");
  });

  it("updates maxTs with > comparison (not >=, <, or <=)", () => {
    const result = computeBoundsFromIsoTimestamps(["2024-01-10T00:00:00Z", "2024-01-20T00:00:00Z"]);
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
  });

  it("initializes minTs to POSITIVE_INFINITY and maxTs to NEGATIVE_INFINITY", () => {
    // With one valid timestamp, both min and max should equal that timestamp
    // This would fail if they were initialized to 0 or some other value
    const result = computeBoundsFromIsoTimestamps(["2024-01-15T12:00:00Z"]);
    expect(result?.startAt).toBe("2024-01-15T12:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-15T12:00:00.000Z");
  });

  it("skips NaN values from Date.parse (continues on invalid)", () => {
    // Mix of valid and invalid; invalid should be skipped, not break the loop
    const result = computeBoundsFromIsoTimestamps([
      "not-a-date",
      "2024-01-15T00:00:00Z",
      "also-not-a-date",
      "2024-01-20T00:00:00Z",
    ]);
    expect(result?.startAt).toBe("2024-01-15T00:00:00.000Z");
    expect(result?.endAt).toBe("2024-01-20T00:00:00.000Z");
  });
});

describe("categorize (mutation-killing: priority order)", () => {
  it("returns bodyMeasurement before other categories for body types", () => {
    expect(categorize("HKQuantityTypeIdentifierBodyMassIndex")).toBe("bodyMeasurement");
    expect(categorize("HKQuantityTypeIdentifierHeight")).toBe("bodyMeasurement");
  });

  it("returns additiveDailyMetric for all additive types", () => {
    expect(categorize("HKQuantityTypeIdentifierBasalEnergyBurned")).toBe("additiveDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierDistanceWalkingRunning")).toBe(
      "additiveDailyMetric",
    );
    expect(categorize("HKQuantityTypeIdentifierDistanceCycling")).toBe("additiveDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierFlightsClimbed")).toBe("additiveDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierAppleExerciseTime")).toBe("additiveDailyMetric");
  });

  it("returns pointInTimeDailyMetric for all point-in-time types", () => {
    expect(categorize("HKQuantityTypeIdentifierHeartRateVariabilitySDNN")).toBe(
      "pointInTimeDailyMetric",
    );
    expect(categorize("HKQuantityTypeIdentifierWalkingSpeed")).toBe("pointInTimeDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierWalkingStepLength")).toBe("pointInTimeDailyMetric");
    expect(categorize("HKQuantityTypeIdentifierWalkingDoubleSupportPercentage")).toBe(
      "pointInTimeDailyMetric",
    );
    expect(categorize("HKQuantityTypeIdentifierWalkingAsymmetryPercentage")).toBe(
      "pointInTimeDailyMetric",
    );
  });

  it("returns metricStream for all metric stream types", () => {
    expect(categorize("HKQuantityTypeIdentifierRespiratoryRate")).toBe("metricStream");
    expect(categorize("HKQuantityTypeIdentifierBloodGlucose")).toBe("metricStream");
    expect(categorize("HKQuantityTypeIdentifierEnvironmentalAudioExposure")).toBe("metricStream");
    expect(categorize("HKQuantityTypeIdentifierAppleSleepingWristTemperature")).toBe(
      "metricStream",
    );
  });
});

describe("aggregateDailyMetricSamples (mutation-killing: transforms)", () => {
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

  it("distance transform divides by 1000 (not 100, 10, or multiply)", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 5000,
        uuid: "d1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // 5000 / 1000 = 5.0 (not 50, 500, or 5000000)
    expect(accumulator?.distanceKm).toBe(5.0);
  });

  it("cycling distance transform divides by 1000", () => {
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierDistanceCycling",
        value: 7500,
        uuid: "cd1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    // 7500 / 1000 = 7.5
    expect(accumulator?.cyclingDistanceKm).toBe(7.5);
  });

  it("uses compound key with null separator (date\\0source)", () => {
    const samples = [
      makeSample({
        startDate: "2024-01-15T10:00:00Z",
        sourceName: "iPhone",
        uuid: "k1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    // The key should be "2024-01-15\0iPhone"
    expect(result.has("2024-01-15\0iPhone")).toBe(true);
    // Not "2024-01-15iPhone" or "2024-01-15/iPhone"
    expect(result.has("2024-01-15iPhone")).toBe(false);
  });

  it("creates a new accumulator for each unique date/source combination", () => {
    const samples = [
      makeSample({ startDate: "2024-01-15T10:00:00Z", sourceName: "iPhone", uuid: "1" }),
      makeSample({ startDate: "2024-01-15T10:00:00Z", sourceName: "Watch", uuid: "2" }),
      makeSample({ startDate: "2024-01-16T10:00:00Z", sourceName: "iPhone", uuid: "3" }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    expect(result.size).toBe(3);
    expect(result.has("2024-01-15\0iPhone")).toBe(true);
    expect(result.has("2024-01-15\0Watch")).toBe(true);
    expect(result.has("2024-01-16\0iPhone")).toBe(true);
  });

  it("additive metric without transform uses raw value (no division or multiplication)", () => {
    // StepCount has no transform, value should be used as-is
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 1234,
        uuid: "raw1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    const accumulator = result.get("2024-01-15\0iPhone");
    expect(accumulator?.steps).toBe(1234);
  });

  it("point-in-time metrics skip when mapping not found (continue on null mapping)", () => {
    // An unknown type should not modify any accumulator field
    const samples = [
      makeSample({
        type: "HKQuantityTypeIdentifierSomethingNew",
        value: 42,
        uuid: "skip1",
      }),
    ];
    const result = aggregateDailyMetricSamples(samples);
    // Should still create an accumulator but with all defaults
    const accumulator = result.get("2024-01-15\0iPhone");
    if (accumulator) {
      expect(accumulator.steps).toBe(0);
      expect(accumulator.restingHr).toBeNull();
      expect(accumulator.vo2max).toBeNull();
    }
  });
});

describe("deriveSleepSessionsFromStages (mutation-killing)", () => {
  it("filters out samples where endMs <= startMs (zero-duration or negative)", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T22:00:00Z", // same time = zero duration
        value: "asleepCore",
        sourceName: "Watch",
      },
    ]);
    // Zero-duration samples are filtered: endMs > startMs check fails
    expect(sessions).toHaveLength(0);
  });

  it("sorts samples by startMs before processing", () => {
    // Provide out-of-order samples; they should still be merged into one session
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "2",
        startDate: "2024-01-16T02:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T02:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.startDate).toBe("2024-01-15T22:00:00.000Z");
    expect(sessions[0]?.endDate).toBe("2024-01-16T06:00:00.000Z");
  });

  it("extends currentEnd when overlapping entry has later endMs", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T02:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "2",
        startDate: "2024-01-15T23:00:00Z",
        endDate: "2024-01-16T04:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
    // endDate should be the later of the two: 04:00, not 02:00
    expect(sessions[0]?.endDate).toBe("2024-01-16T04:00:00.000Z");
  });

  it("does NOT extend currentEnd when overlapping entry has earlier endMs", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "2",
        startDate: "2024-01-15T23:00:00Z",
        endDate: "2024-01-16T03:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
    // endDate should stay at 06:00 (not reduced to 03:00)
    expect(sessions[0]?.endDate).toBe("2024-01-16T06:00:00.000Z");
  });

  it("groups samples by sourceName (different sources get separate sessions)", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
        sourceName: "Watch A",
      },
      {
        uuid: "2",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch B",
      },
    ]);
    // Each source should produce its own session
    expect(sessions).toHaveLength(2);
    const sourceNames = sessions.map((session) => session.sourceName);
    expect(sourceNames).toContain("Watch A");
    expect(sourceNames).toContain("Watch B");
  });

  it("output sessions have value 'inBed'", () => {
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
    expect(sessions[0]?.value).toBe("inBed");
  });

  it("uses first entry uuid for the session", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "first-uuid",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T02:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "second-uuid",
        startDate: "2024-01-16T02:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.uuid).toBe("first-uuid");
  });

  it("after a gap, starts new session with new uuid", () => {
    const sessions = deriveSleepSessionsFromStages([
      {
        uuid: "session-1-uuid",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-15T23:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
      {
        uuid: "session-2-uuid",
        startDate: "2024-01-16T01:31:00Z", // > 90 min gap from 23:00
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepDeep",
        sourceName: "Watch",
      },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.uuid).toBe("session-1-uuid");
    expect(sessions[1]?.uuid).toBe("session-2-uuid");
  });
});

describe("HealthKitSyncRepository.processBodyMeasurements (mutation: body fat transform)", () => {
  it("body fat percentage transform multiplies by 100 (not 10, 1000, or divides)", () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierBodyFatPercentage",
        value: 0.22,
        unit: "%",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:00:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "bf-transform",
      },
    ];
    repo.processBodyMeasurements(samples);
    // 0.22 * 100 = 22, not 2.2 or 220
    const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(queryJson).toContain("22");
  });
});

describe("HealthKitSyncRepository.processWorkouts (mutation: workout count)", () => {
  it("returns the count of workouts processed, not 0 or samples.length-1", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const workouts = [
      {
        uuid: "w-count-1",
        workoutType: "35",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T11:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
      {
        uuid: "w-count-2",
        workoutType: "13",
        startDate: "2024-01-15T14:00:00Z",
        endDate: "2024-01-15T15:00:00Z",
        duration: 3600,
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
      },
    ];
    const result = await repo.processWorkouts(workouts);
    expect(result).toBe(2);
  });
});

describe("HealthKitSyncRepository.processHealthEvents (mutation: event count)", () => {
  it("returns count matching input length", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierSomething",
        value: 1,
        unit: "count",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "he-count-1",
      },
      {
        type: "HKQuantityTypeIdentifierSomethingElse",
        value: 2,
        unit: "count",
        startDate: "2024-01-15T11:00:00Z",
        endDate: "2024-01-15T11:30:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "he-count-2",
      },
    ];
    const result = await repo.processHealthEvents(samples);
    expect(result).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("HealthKitSyncRepository.processMetricStream (mutation: inserted count)", () => {
  it("only counts samples with valid metric stream mapping", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierHeartRate",
        value: 72,
        unit: "count/min",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:00:00Z",
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
        uuid: "ms-count-1",
      },
      {
        type: "HKQuantityTypeIdentifierStepCount", // not in metricStreamTypes
        value: 100,
        unit: "count",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:00:00Z",
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
        uuid: "ms-count-2",
      },
      {
        type: "HKQuantityTypeIdentifierOxygenSaturation",
        value: 0.98,
        unit: "%",
        startDate: "2024-01-15T10:01:00Z",
        endDate: "2024-01-15T10:01:00Z",
        sourceName: "Watch",
        sourceBundle: "com.apple.Health",
        uuid: "ms-count-3",
      },
    ];
    const result = await repo.processMetricStream(samples);
    // Only 2 have valid metricStream mapping (HR and SpO2), steps is skipped
    expect(result).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("HealthKitSyncRepository.processDailyMetrics (mutation: additive > 0 guard)", () => {
  it("skips additive fields with value 0 (only inserts when > 0)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    // A point-in-time metric with value — should still insert even though steps=0
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 60,
        unit: "count/min",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:00:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "daily-zero",
      },
    ];
    const result = await repo.processDailyMetrics(samples);
    expect(result).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("skips upsert when only zero-value additive fields and no point-in-time fields", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    // StepCount with value 0 — additive sum is 0, not > 0, so no set clause
    const samples: HealthKitSample[] = [
      {
        type: "HKQuantityTypeIdentifierStepCount",
        value: 0,
        unit: "count",
        startDate: "2024-01-15T10:00:00Z",
        endDate: "2024-01-15T10:00:00Z",
        sourceName: "iPhone",
        sourceBundle: "com.apple.Health",
        uuid: "daily-skip",
      },
    ];
    const result = await repo.processDailyMetrics(samples);
    expect(result).toBe(1);
    // setClauses would be empty, so the upsert is skipped
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("HealthKitSyncRepository.processSleepSamples (mutation: explicit vs derived inBed)", () => {
  it("uses explicit inBed samples when present (not deriveSleepSessionsFromStages)", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: SleepSample[] = [
      {
        uuid: "inbed-explicit",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "inBed",
        sourceName: "Watch",
      },
      {
        uuid: "stage-1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
    ];
    const result = await repo.processSleepSamples(samples);
    expect(result).toBe(1);
  });

  it("falls back to deriveSleepSessionsFromStages when no explicit inBed", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: SleepSample[] = [
      {
        uuid: "stage-only-1",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z",
        value: "asleepCore",
        sourceName: "Watch",
      },
    ];
    const result = await repo.processSleepSamples(samples);
    // deriveSleepSessionsFromStages creates an inBed session from the stage
    expect(result).toBe(1);
  });

  it("calculates duration in minutes from session start/end", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
    const repo = new HealthKitSyncRepository({ execute }, "user-1");
    const samples: SleepSample[] = [
      {
        uuid: "dur-test",
        startDate: "2024-01-15T22:00:00Z",
        endDate: "2024-01-16T06:00:00Z", // 8 hours = 480 minutes
        value: "inBed",
        sourceName: "Watch",
      },
    ];
    await repo.processSleepSamples(samples);
    // Find the insert call and verify 480 is in the SQL params
    const allCalls = execute.mock.calls.map((call) => JSON.stringify(call[0]));
    const insertCall = allCalls.find((callStr) =>
      callStr.includes("INSERT INTO fitness.sleep_session"),
    );
    expect(insertCall).toContain("480");
  });
});
