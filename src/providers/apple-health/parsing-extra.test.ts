import { describe, expect, it } from "vitest";
import { extractCalendarDay, parseHealthDate } from "./dates.ts";
import { parseCategoryRecord, parseRecord, parseRouteLocation } from "./records.ts";
import { parseSleepAnalysis } from "./sleep.ts";
import {
  enrichWorkoutFromStats,
  parseActivitySummary,
  parseWorkout,
  parseWorkoutStatistics,
  type WorkoutStatistics,
} from "./workouts.ts";

// ============================================================
// Tests targeting uncovered parsing functions in apple-health.ts
// ============================================================

describe("parseHealthDate", () => {
  it("parses Apple Health date format with timezone offset", () => {
    const date = parseHealthDate("2024-03-01 10:30:00 -0500");
    expect(date.toISOString()).toBe("2024-03-01T15:30:00.000Z");
  });

  it("parses positive timezone offset", () => {
    const date = parseHealthDate("2024-06-15 14:00:00 +0200");
    expect(date.toISOString()).toBe("2024-06-15T12:00:00.000Z");
  });

  it("falls back to Date constructor for non-matching format", () => {
    const date = parseHealthDate("2024-03-01T10:30:00Z");
    expect(date.toISOString()).toBe("2024-03-01T10:30:00.000Z");
  });
});

describe("extractCalendarDay", () => {
  it("extracts day from Apple Health date format", () => {
    expect(extractCalendarDay("2024-03-01 23:30:00 -0800")).toBe("2024-03-01");
  });

  it("extracts day from ISO timestamp", () => {
    expect(extractCalendarDay("2024-03-01T23:30:00-08:00")).toBe("2024-03-01");
  });

  it("returns null for invalid date strings", () => {
    expect(extractCalendarDay("not-a-date")).toBeNull();
  });
});

describe("parseRecord", () => {
  it("parses a record with all fields", () => {
    const attrs = {
      type: "HKQuantityTypeIdentifierHeartRate",
      sourceName: "Apple Watch",
      unit: "count/min",
      value: "72",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:05 -0500",
    };
    const record = parseRecord(attrs);
    expect(record).not.toBeNull();
    expect(record?.type).toBe("HKQuantityTypeIdentifierHeartRate");
    expect(record?.sourceName).toBe("Apple Watch");
    expect(record?.unit).toBe("count/min");
    expect(record?.value).toBe(72);
    expect(record?.startDateCalendarDay).toBe("2024-03-01");
  });

  it("returns null when type is missing", () => {
    expect(parseRecord({ value: "10" })).toBeNull();
  });

  it("returns null when value is NaN", () => {
    expect(parseRecord({ type: "SomeType", value: "abc" })).toBeNull();
  });

  it("handles missing optional fields", () => {
    const record = parseRecord({ type: "Test", value: "5" });
    expect(record?.sourceName).toBeNull();
    expect(record?.unit).toBeNull();
  });
});

describe("parseCategoryRecord", () => {
  it("parses a category record", () => {
    const attrs = {
      type: "HKCategoryTypeIdentifierMindfulSession",
      sourceName: "Headspace",
      value: "HKCategoryValueNotApplicable",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 08:10:00 -0500",
    };
    const record = parseCategoryRecord(attrs);
    expect(record).not.toBeNull();
    expect(record?.type).toBe("HKCategoryTypeIdentifierMindfulSession");
    expect(record?.sourceName).toBe("Headspace");
    expect(record?.value).toBe("HKCategoryValueNotApplicable");
  });

  it("returns null when type is missing", () => {
    expect(parseCategoryRecord({ value: "test" })).toBeNull();
  });

  it("handles missing value and source", () => {
    const record = parseCategoryRecord({ type: "Test" });
    expect(record?.value).toBeNull();
    expect(record?.sourceName).toBeNull();
  });
});

describe("parseSleepAnalysis", () => {
  it("parses known sleep stages", () => {
    const base = {
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 00:30:00 -0500",
    };

    expect(parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisInBed" })?.stage).toBe(
      "inBed",
    );
    expect(
      parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisAsleepCore" })?.stage,
    ).toBe("core");
    expect(
      parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisAsleepDeep" })?.stage,
    ).toBe("deep");
    expect(
      parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisAsleepREM" })?.stage,
    ).toBe("rem");
    expect(parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisAwake" })?.stage).toBe(
      "awake",
    );
    expect(
      parseSleepAnalysis({ ...base, value: "HKCategoryValueSleepAnalysisAsleepUnspecified" })
        ?.stage,
    ).toBe("asleep");
  });

  it("parses legacy numeric values", () => {
    const base = {
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    };
    expect(parseSleepAnalysis({ ...base, value: "0" })?.stage).toBe("inBed");
    expect(parseSleepAnalysis({ ...base, value: "1" })?.stage).toBe("asleep");
    expect(parseSleepAnalysis({ ...base, value: "2" })?.stage).toBe("awake");
  });

  it("calculates duration in minutes", () => {
    const record = parseSleepAnalysis({
      value: "HKCategoryValueSleepAnalysisAsleepCore",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 00:30:00 -0500",
    });
    expect(record?.durationMinutes).toBe(90);
  });

  it("returns null for missing value", () => {
    expect(parseSleepAnalysis({})).toBeNull();
  });

  it("returns null for unknown sleep stage", () => {
    expect(parseSleepAnalysis({ value: "UnknownStage" })).toBeNull();
  });
});

describe("parseWorkout", () => {
  it("parses a cycling workout", () => {
    const attrs = {
      workoutActivityType: "HKWorkoutActivityTypeCycling",
      sourceName: "Apple Watch",
      duration: "60",
      durationUnit: "min",
      totalDistance: "30",
      totalDistanceUnit: "km",
      totalEnergyBurned: "500.5",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    };
    const workout = parseWorkout(attrs);
    expect(workout.activityType).toBe("cycling");
    expect(workout.durationSeconds).toBe(3600);
    expect(workout.distanceMeters).toBe(30000);
    expect(workout.calories).toBe(501);
    expect(workout.sourceName).toBe("Apple Watch");
  });

  it("handles duration in hours", () => {
    const workout = parseWorkout({
      duration: "1.5",
      durationUnit: "hr",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:30:00 -0500",
    });
    expect(workout.durationSeconds).toBe(5400);
  });

  it("handles distance in miles", () => {
    const workout = parseWorkout({
      totalDistance: "5",
      totalDistanceUnit: "mi",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });
    expect(workout.distanceMeters).toBeCloseTo(8046.72, 0);
  });

  it("defaults to meters and seconds for unknown units", () => {
    const workout = parseWorkout({
      duration: "3600",
      durationUnit: "s",
      totalDistance: "5000",
      totalDistanceUnit: "m",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });
    expect(workout.durationSeconds).toBe(3600);
    expect(workout.distanceMeters).toBe(5000);
  });

  it("handles missing optional fields", () => {
    const workout = parseWorkout({
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });
    expect(workout.activityType).toBe("other");
    expect(workout.distanceMeters).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });

  it("maps common workout types", () => {
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeRunning",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("running");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeSwimming",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("swimming");
    expect(
      parseWorkout({ workoutActivityType: "HKWorkoutActivityTypeYoga", startDate: "", endDate: "" })
        .activityType,
    ).toBe("yoga");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeHiking",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("hiking");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeRowing",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("rowing");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeElliptical",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("elliptical");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeHighIntensityIntervalTraining",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("hiit");
    expect(
      parseWorkout({
        workoutActivityType: "HKWorkoutActivityTypeTraditionalStrengthTraining",
        startDate: "",
        endDate: "",
      }).activityType,
    ).toBe("strength_training");
  });

  it("returns other for unknown HKWorkoutActivityType suffix", () => {
    const workout = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeSomethingNew",
      startDate: "",
      endDate: "",
    });
    expect(workout.activityType).toBe("other");
  });
});

describe("parseRouteLocation", () => {
  it("parses a route location with all fields", () => {
    const attrs = {
      date: "2024-03-01 08:00:00 -0500",
      latitude: "40.7128",
      longitude: "-74.0060",
      altitude: "15.5",
      horizontalAccuracy: "3.2",
      verticalAccuracy: "5.0",
      course: "180",
      speed: "4.5",
    };
    const loc = parseRouteLocation(attrs);
    expect(loc).not.toBeNull();
    expect(loc?.lat).toBe(40.7128);
    expect(loc?.lng).toBe(-74.006);
    expect(loc?.altitude).toBe(15.5);
    expect(loc?.horizontalAccuracy).toBe(3.2);
    expect(loc?.verticalAccuracy).toBe(5.0);
    expect(loc?.course).toBe(180);
    expect(loc?.speed).toBe(4.5);
  });

  it("returns null for missing lat/lng", () => {
    expect(parseRouteLocation({})).toBeNull();
    expect(parseRouteLocation({ latitude: "40.7" })).toBeNull();
    expect(parseRouteLocation({ longitude: "-74.0" })).toBeNull();
  });

  it("handles missing optional fields", () => {
    const loc = parseRouteLocation({
      latitude: "40.7",
      longitude: "-74.0",
    });
    expect(loc?.altitude).toBeUndefined();
    expect(loc?.speed).toBeUndefined();
  });
});

describe("parseActivitySummary", () => {
  it("parses a complete activity summary", () => {
    const summary = parseActivitySummary({
      dateComponents: "2024-03-01",
      activeEnergyBurned: "500",
      appleExerciseTime: "45",
      appleStandHours: "12",
    });
    expect(summary).not.toBeNull();
    expect(summary?.date).toBe("2024-03-01");
    expect(summary?.activeEnergyBurned).toBe(500);
    expect(summary?.appleExerciseMinutes).toBe(45);
    expect(summary?.appleStandHours).toBe(12);
  });

  it("returns null when dateComponents is missing", () => {
    expect(parseActivitySummary({})).toBeNull();
  });

  it("handles missing optional fields", () => {
    const summary = parseActivitySummary({ dateComponents: "2024-03-01" });
    expect(summary?.activeEnergyBurned).toBeUndefined();
    expect(summary?.appleExerciseMinutes).toBeUndefined();
    expect(summary?.appleStandHours).toBeUndefined();
  });
});

describe("parseWorkoutStatistics", () => {
  it("parses complete statistics", () => {
    const stats = parseWorkoutStatistics({
      type: "HKQuantityTypeIdentifierHeartRate",
      sum: "14400",
      average: "150",
      minimum: "120",
      maximum: "185",
      unit: "count/min",
    });
    expect(stats).not.toBeNull();
    expect(stats?.type).toBe("HKQuantityTypeIdentifierHeartRate");
    expect(stats?.sum).toBe(14400);
    expect(stats?.average).toBe(150);
    expect(stats?.minimum).toBe(120);
    expect(stats?.maximum).toBe(185);
    expect(stats?.unit).toBe("count/min");
  });

  it("returns null when type is missing", () => {
    expect(parseWorkoutStatistics({})).toBeNull();
  });

  it("handles missing optional fields", () => {
    const stats = parseWorkoutStatistics({ type: "Test" });
    expect(stats?.sum).toBeUndefined();
    expect(stats?.average).toBeUndefined();
    expect(stats?.minimum).toBeUndefined();
    expect(stats?.maximum).toBeUndefined();
    expect(stats?.unit).toBeUndefined();
  });
});

describe("enrichWorkoutFromStats", () => {
  it("enriches workout with heart rate stats", () => {
    const workout = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeCycling",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });

    const stats: WorkoutStatistics[] = [
      { type: "HKQuantityTypeIdentifierHeartRate", average: 150.4, maximum: 185.7 },
    ];

    enrichWorkoutFromStats(workout, stats);
    expect(workout.avgHeartRate).toBe(150);
    expect(workout.maxHeartRate).toBe(186);
  });

  it("enriches workout with active energy burned when calories not set", () => {
    const workout = parseWorkout({
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });

    const stats: WorkoutStatistics[] = [
      { type: "HKQuantityTypeIdentifierActiveEnergyBurned", sum: 450.6 },
    ];

    enrichWorkoutFromStats(workout, stats);
    expect(workout.calories).toBe(451);
  });

  it("does not overwrite existing calories", () => {
    const workout = parseWorkout({
      totalEnergyBurned: "500",
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });

    const stats: WorkoutStatistics[] = [
      { type: "HKQuantityTypeIdentifierActiveEnergyBurned", sum: 300 },
    ];

    enrichWorkoutFromStats(workout, stats);
    expect(workout.calories).toBe(500); // Original, not overwritten
  });

  it("ignores irrelevant stats types", () => {
    const workout = parseWorkout({
      startDate: "2024-03-01 08:00:00 -0500",
      endDate: "2024-03-01 09:00:00 -0500",
    });

    const stats: WorkoutStatistics[] = [{ type: "HKQuantityTypeIdentifierStepCount", sum: 5000 }];

    enrichWorkoutFromStats(workout, stats);
    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });
});
