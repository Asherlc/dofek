import { describe, expect, it } from "vitest";
import {
  decimalHoursToSeconds,
  parseTrainingPeaksPmc,
  parseTrainingPeaksWorkout,
} from "./parsing.ts";
import type { TrainingPeaksPmcEntry, TrainingPeaksWorkout } from "./types.ts";

describe("decimalHoursToSeconds", () => {
  it("converts whole hours", () => {
    expect(decimalHoursToSeconds(1)).toBe(3600);
    expect(decimalHoursToSeconds(2)).toBe(7200);
  });

  it("converts fractional hours", () => {
    expect(decimalHoursToSeconds(1.5)).toBe(5400);
    expect(decimalHoursToSeconds(1.25)).toBe(4500);
    expect(decimalHoursToSeconds(0.5)).toBe(1800);
  });

  it("handles zero", () => {
    expect(decimalHoursToSeconds(0)).toBe(0);
  });

  it("handles small values", () => {
    expect(decimalHoursToSeconds(0.01)).toBe(36);
  });
});

describe("parseTrainingPeaksWorkout", () => {
  const baseWorkout: TrainingPeaksWorkout = {
    workoutId: 123456789,
    athleteId: 42,
    workoutDay: "2024-06-15",
    title: "Tempo Ride",
    completed: true,
    workoutTypeFamilyId: 2,
    workoutTypeValueId: 10,
    totalTime: 1.5,
    distance: 45000,
    tssActual: 120,
    if: 0.85,
    powerAverage: 220,
    normalizedPowerActual: 240,
    heartRateAverage: 145,
    heartRateMaximum: 172,
    cadenceAverage: 88,
    elevationGain: 450,
    calories: 850,
    feeling: 3,
    rpe: 6,
    startTime: "2024-06-15T07:30:00",
  };

  it("parses basic workout fields", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.externalId).toBe("123456789");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Tempo Ride");
    expect(parsed.completed).toBe(true);
    expect(parsed.startedAt).toEqual(new Date("2024-06-15T07:30:00"));
  });

  it("converts decimal hours to seconds for duration and end time", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.durationSeconds).toBe(5400);
    const expectedEnd = new Date(new Date("2024-06-15T07:30:00").getTime() + 5400000);
    expect(parsed.endedAt).toEqual(expectedEnd);
  });

  it("includes power and training metrics", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.averagePower).toBe(220);
    expect(parsed.normalizedPower).toBe(240);
    expect(parsed.trainingStressScore).toBe(120);
    expect(parsed.intensityFactor).toBe(0.85);
  });

  it("includes heart rate and cadence", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.averageHeartRate).toBe(145);
    expect(parsed.maxHeartRate).toBe(172);
    expect(parsed.cadenceAverage).toBe(88);
  });

  it("includes elevation and calories", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.elevationGain).toBe(450);
    expect(parsed.calories).toBe(850);
  });

  it("includes subjective metrics", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.feeling).toBe(3);
    expect(parsed.rpe).toBe(6);
  });

  it("preserves raw workout data", () => {
    const parsed = parseTrainingPeaksWorkout(baseWorkout);
    expect(parsed.raw).toBe(baseWorkout);
  });

  it("falls back to workoutDay when startTime is missing", () => {
    const noStart: TrainingPeaksWorkout = {
      ...baseWorkout,
      startTime: undefined,
      startTimePlanned: undefined,
    };
    const parsed = parseTrainingPeaksWorkout(noStart);
    expect(parsed.startedAt).toEqual(new Date("2024-06-15"));
  });

  it("falls back to planned values when actual values are missing", () => {
    const planned: TrainingPeaksWorkout = {
      ...baseWorkout,
      tssActual: undefined,
      tssPlanned: 100,
      if: undefined,
      ifPlanned: 0.75,
      totalTime: undefined,
      totalTimePlanned: 1.0,
    };
    const parsed = parseTrainingPeaksWorkout(planned);
    expect(parsed.trainingStressScore).toBe(100);
    expect(parsed.intensityFactor).toBe(0.75);
    expect(parsed.durationSeconds).toBe(3600);
  });

  it("handles missing optional fields", () => {
    const minimal: TrainingPeaksWorkout = {
      workoutId: 999,
      athleteId: 1,
      workoutDay: "2024-01-01",
      title: "Rest Day",
      completed: false,
      workoutTypeFamilyId: 12,
      workoutTypeValueId: 0,
    };
    const parsed = parseTrainingPeaksWorkout(minimal);
    expect(parsed.activityType).toBe("rest");
    expect(parsed.distanceMeters).toBeUndefined();
    expect(parsed.averagePower).toBeUndefined();
    expect(parsed.trainingStressScore).toBeUndefined();
    expect(parsed.durationSeconds).toBeUndefined();
  });

  it("maps sport types correctly", () => {
    const types: Array<[number, string]> = [
      [1, "swimming"],
      [2, "cycling"],
      [3, "running"],
      [7, "strength"],
      [10, "other"],
      [12, "rest"],
      [99, "other"],
    ];
    for (const [familyId, expected] of types) {
      const workout = { ...baseWorkout, workoutTypeFamilyId: familyId };
      expect(parseTrainingPeaksWorkout(workout).activityType).toBe(expected);
    }
  });
});

describe("parseTrainingPeaksPmc", () => {
  it("parses PMC data with readable field names", () => {
    const entry: TrainingPeaksPmcEntry = {
      workoutDay: "2024-06-15",
      tssActual: 85,
      ctl: 72,
      atl: 65,
      tsb: 7,
    };
    const parsed = parseTrainingPeaksPmc(entry);
    expect(parsed.date).toBe("2024-06-15");
    expect(parsed.tss).toBe(85);
    expect(parsed.fitness).toBe(72);
    expect(parsed.fatigue).toBe(65);
    expect(parsed.form).toBe(7);
  });

  it("handles negative form (TSB)", () => {
    const entry: TrainingPeaksPmcEntry = {
      workoutDay: "2024-06-15",
      tssActual: 150,
      ctl: 60,
      atl: 90,
      tsb: -30,
    };
    const parsed = parseTrainingPeaksPmc(entry);
    expect(parsed.form).toBe(-30);
  });
});
