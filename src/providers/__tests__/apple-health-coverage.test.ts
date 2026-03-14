import { describe, expect, it } from "vitest";
import {
  enrichWorkoutFromStats,
  type HealthWorkout,
  parseActivitySummary,
  parseCategoryRecord,
  parseHealthDate,
  parseRecord,
  parseRouteLocation,
  parseSleepAnalysis,
  parseWorkout,
  parseWorkoutStatistics,
} from "../apple-health.ts";

// ============================================================
// Coverage tests for untested Apple Health paths
// - parseHealthDate edge cases
// - parseRecord edge cases (missing type, NaN value)
// - parseSleepAnalysis with legacy numeric values and unknown values
// - parseWorkout with distance unit conversions (km, mi)
// - parseWorkout with duration unit conversions (hr, default seconds)
// - parseWorkout with unknown activity types
// - parseWorkoutStatistics edge cases
// - enrichWorkoutFromStats with no matching stat types
// - parseCategoryRecord without value
// - parseRouteLocation with NaN coordinates
// ============================================================

describe("parseHealthDate — edge cases", () => {
  it("parses standard Apple Health format", () => {
    const date = parseHealthDate("2024-03-01 10:30:00 -0500");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("falls back to Date constructor for non-standard format", () => {
    const date = parseHealthDate("2024-03-01T10:30:00Z");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("handles positive timezone offset", () => {
    const date = parseHealthDate("2024-03-01 10:30:00 +0530");
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).not.toBeNaN();
  });

  it("handles empty string gracefully", () => {
    const date = parseHealthDate("");
    expect(date).toBeInstanceOf(Date);
    // Empty string Date is invalid, which is expected fallback behavior
  });
});

describe("parseRecord — edge cases", () => {
  it("returns null when type is missing", () => {
    const result = parseRecord({
      value: "72",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is NaN", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: "not-a-number",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is missing", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("handles missing sourceName and unit", () => {
    const result = parseRecord({
      type: "HKQuantityTypeIdentifierHeartRate",
      value: "72",
      startDate: "2024-03-01 10:00:00 -0500",
      endDate: "2024-03-01 10:00:05 -0500",
      creationDate: "2024-03-01 10:00:00 -0500",
    });
    expect(result).not.toBeNull();
    expect(result?.sourceName).toBeNull();
    expect(result?.unit).toBeNull();
  });
});

describe("parseSleepAnalysis — legacy numeric values", () => {
  it("parses legacy '0' as inBed", () => {
    const result = parseSleepAnalysis({
      value: "0",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("inBed");
  });

  it("parses legacy '1' as asleep", () => {
    const result = parseSleepAnalysis({
      value: "1",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("asleep");
  });

  it("parses legacy '2' as awake", () => {
    const result = parseSleepAnalysis({
      value: "2",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 02:05:00 -0500",
    });
    expect(result?.stage).toBe("awake");
  });

  it("returns null for unknown sleep stage value", () => {
    const result = parseSleepAnalysis({
      value: "UnknownSleepStage",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("returns null when value is missing", () => {
    const result = parseSleepAnalysis({
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result).toBeNull();
  });

  it("parses AsleepUnspecified", () => {
    const result = parseSleepAnalysis({
      value: "HKCategoryValueSleepAnalysisAsleepUnspecified",
      startDate: "2024-03-01 23:00:00 -0500",
      endDate: "2024-03-02 07:00:00 -0500",
    });
    expect(result?.stage).toBe("asleep");
  });
});

describe("parseWorkout — distance and duration unit conversions", () => {
  it("converts distance in km to meters", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "10",
      totalDistanceUnit: "km",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBeCloseTo(10000);
  });

  it("converts distance in miles to meters", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "1",
      totalDistanceUnit: "mi",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBeCloseTo(1609.344);
  });

  it("assumes meters for unknown distance unit", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "30",
      durationUnit: "min",
      totalDistance: "5000",
      totalDistanceUnit: "m",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.distanceMeters).toBe(5000);
  });

  it("converts duration in hours to seconds", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeCycling",
      duration: "1.5",
      durationUnit: "hr",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 19:30:00 -0500",
    });
    expect(result.durationSeconds).toBeCloseTo(5400);
  });

  it("assumes seconds for unknown duration unit", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeRunning",
      duration: "1800",
      durationUnit: "sec",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.durationSeconds).toBe(1800);
  });

  it("handles unknown workout activity type by stripping prefix", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeFutureNewSport",
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("futurenewsport");
  });

  it("defaults to 'other' for HKWorkoutActivityTypeOther", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeOther",
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("other");
  });

  it("defaults to 'other' when workoutActivityType is missing", () => {
    const result = parseWorkout({
      duration: "30",
      durationUnit: "min",
      sourceName: "Apple Watch",
      startDate: "2024-03-01 18:00:00 -0500",
      endDate: "2024-03-01 18:30:00 -0500",
    });
    expect(result.activityType).toBe("other");
  });
});

describe("parseWorkoutStatistics — edge cases", () => {
  it("returns null when type is missing", () => {
    const result = parseWorkoutStatistics({
      average: "145",
      unit: "count/min",
    });
    expect(result).toBeNull();
  });

  it("handles stats with only sum", () => {
    const result = parseWorkoutStatistics({
      type: "HKQuantityTypeIdentifierActiveEnergyBurned",
      sum: "320",
      unit: "kcal",
    });
    expect(result).not.toBeNull();
    expect(result?.sum).toBe(320);
    expect(result?.average).toBeUndefined();
    expect(result?.minimum).toBeUndefined();
    expect(result?.maximum).toBeUndefined();
  });
});

describe("enrichWorkoutFromStats — edge cases", () => {
  it("does not modify workout for unrecognized stat types", () => {
    const workout: HealthWorkout = {
      activityType: "running",
      sourceName: "Apple Watch",
      durationSeconds: 1800,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T18:30:00Z"),
    };

    enrichWorkoutFromStats(workout, [
      {
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        sum: 5000,
        unit: "m",
      },
    ]);

    // Should not have modified avgHeartRate, maxHeartRate, or calories
    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.maxHeartRate).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });

  it("handles empty stats array", () => {
    const workout: HealthWorkout = {
      activityType: "running",
      sourceName: "Apple Watch",
      durationSeconds: 1800,
      startDate: new Date("2024-03-01T18:00:00Z"),
      endDate: new Date("2024-03-01T18:30:00Z"),
    };

    enrichWorkoutFromStats(workout, []);

    expect(workout.avgHeartRate).toBeUndefined();
    expect(workout.maxHeartRate).toBeUndefined();
    expect(workout.calories).toBeUndefined();
  });
});

describe("parseActivitySummary — additional edge cases", () => {
  it("handles zero values", () => {
    const result = parseActivitySummary({
      dateComponents: "2024-03-01",
      activeEnergyBurned: "0",
      appleExerciseTime: "0",
      appleStandHours: "0",
    });
    expect(result).not.toBeNull();
    expect(result?.activeEnergyBurned).toBe(0);
    expect(result?.appleExerciseMinutes).toBe(0);
    expect(result?.appleStandHours).toBe(0);
  });
});

describe("parseCategoryRecord — edge cases", () => {
  it("handles missing value", () => {
    const result = parseCategoryRecord({
      type: "HKCategoryTypeIdentifierMindfulSession",
      sourceName: "Headspace",
      startDate: "2024-03-01 07:00:00 -0500",
      endDate: "2024-03-01 07:15:00 -0500",
    });
    expect(result).not.toBeNull();
    expect(result?.value).toBeNull();
  });

  it("handles missing sourceName", () => {
    const result = parseCategoryRecord({
      type: "HKCategoryTypeIdentifierMindfulSession",
      value: "1",
      startDate: "2024-03-01 07:00:00 -0500",
      endDate: "2024-03-01 07:15:00 -0500",
    });
    expect(result).not.toBeNull();
    expect(result?.sourceName).toBeNull();
  });
});

describe("parseRouteLocation — NaN coordinates", () => {
  it("returns null for NaN latitude", () => {
    const result = parseRouteLocation({
      date: "2024-03-01 18:00:00 -0500",
      latitude: "NaN",
      longitude: "-74.006",
    });
    expect(result).toBeNull();
  });

  it("returns null for NaN longitude", () => {
    const result = parseRouteLocation({
      date: "2024-03-01 18:00:00 -0500",
      latitude: "40.7128",
      longitude: "NaN",
    });
    expect(result).toBeNull();
  });
});
