import { describe, expect, it } from "vitest";
import {
  type GarminActivitySummary,
  type GarminBodyComposition,
  type GarminDailySummary,
  type GarminSleepSummary,
  mapGarminActivityType,
  parseGarminActivity,
  parseGarminBodyComposition,
  parseGarminDailySummary,
  parseGarminSleep,
} from "./garmin.ts";

// ============================================================
// Activity type mapping
// ============================================================

describe("mapGarminActivityType", () => {
  it("maps running types", () => {
    expect(mapGarminActivityType("RUNNING")).toBe("running");
    expect(mapGarminActivityType("TRAIL_RUNNING")).toBe("running");
    expect(mapGarminActivityType("TREADMILL_RUNNING")).toBe("running");
    expect(mapGarminActivityType("TRACK_RUNNING")).toBe("running");
  });

  it("maps cycling types", () => {
    expect(mapGarminActivityType("CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("MOUNTAIN_BIKING")).toBe("cycling");
    expect(mapGarminActivityType("ROAD_BIKING")).toBe("cycling");
    expect(mapGarminActivityType("INDOOR_CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("GRAVEL_CYCLING")).toBe("cycling");
    expect(mapGarminActivityType("VIRTUAL_RIDE")).toBe("cycling");
  });

  it("maps swimming types", () => {
    expect(mapGarminActivityType("SWIMMING")).toBe("swimming");
    expect(mapGarminActivityType("LAP_SWIMMING")).toBe("swimming");
    expect(mapGarminActivityType("OPEN_WATER_SWIMMING")).toBe("swimming");
  });

  it("maps walking and hiking", () => {
    expect(mapGarminActivityType("WALKING")).toBe("walking");
    expect(mapGarminActivityType("HIKING")).toBe("hiking");
  });

  it("maps strength training", () => {
    expect(mapGarminActivityType("STRENGTH_TRAINING")).toBe("strength");
    expect(mapGarminActivityType("INDOOR_CARDIO")).toBe("cardio");
  });

  it("maps yoga and other fitness types", () => {
    expect(mapGarminActivityType("YOGA")).toBe("yoga");
    expect(mapGarminActivityType("PILATES")).toBe("pilates");
    expect(mapGarminActivityType("ELLIPTICAL")).toBe("elliptical");
    expect(mapGarminActivityType("ROWING")).toBe("rowing");
  });

  it("returns 'other' for unknown types", () => {
    expect(mapGarminActivityType("PARAGLIDING")).toBe("other");
    expect(mapGarminActivityType("")).toBe("other");
  });
});

// ============================================================
// Activity parsing
// ============================================================

// 2024-06-15T14:30:00Z = 1718461800 epoch seconds
const sampleActivity: GarminActivitySummary = {
  activityId: 12345678,
  activityName: "Morning Run",
  activityType: "RUNNING",
  startTimeInSeconds: 1718461800, // 2024-06-15T14:30:00Z
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 3600,
  distanceInMeters: 10000,
  averageHeartRateInBeatsPerMinute: 155,
  maxHeartRateInBeatsPerMinute: 185,
  averageSpeedInMetersPerSecond: 2.78,
  activeKilocalories: 750,
  totalElevationGainInMeters: 120.5,
  totalElevationLossInMeters: 115.2,
  averageRunCadenceInStepsPerMinute: 170,
};

describe("parseGarminActivity", () => {
  it("maps all fields correctly", () => {
    const result = parseGarminActivity(sampleActivity);
    expect(result.externalId).toBe("12345678");
    expect(result.activityType).toBe("running");
    expect(result.name).toBe("Morning Run");
    expect(result.startedAt).toEqual(new Date(1718461800 * 1000));
    expect(result.endedAt).toEqual(new Date((1718461800 + 3600) * 1000));
    expect(result.raw).toBe(sampleActivity);
  });

  it("uses epoch seconds for start time", () => {
    const result = parseGarminActivity(sampleActivity);
    expect(result.startedAt).toEqual(new Date(1718461800 * 1000));
  });

  it("computes endedAt from startTimeInSeconds + durationInSeconds", () => {
    const result = parseGarminActivity(sampleActivity);
    const expectedEnd = new Date((1718461800 + 3600) * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("handles missing optional fields", () => {
    const minimal: GarminActivitySummary = {
      activityId: 99999,
      activityName: "Walk",
      activityType: "WALKING",
      startTimeInSeconds: 1718452800,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 1800,
      distanceInMeters: 2000,
    };
    const result = parseGarminActivity(minimal);
    expect(result.externalId).toBe("99999");
    expect(result.activityType).toBe("walking");
  });

  it("handles zero duration", () => {
    const zeroDuration = { ...sampleActivity, durationInSeconds: 0 };
    const result = parseGarminActivity(zeroDuration);
    expect(result.endedAt).toEqual(result.startedAt);
  });
});

// ============================================================
// Sleep parsing
// ============================================================

const sampleSleep: GarminSleepSummary = {
  calendarDate: "2024-06-15",
  startTimeInSeconds: 1718409600, // 2024-06-15T00:00:00Z
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 25200, // 7 hours
  deepSleepDurationInSeconds: 5400, // 90 min
  lightSleepDurationInSeconds: 10800, // 180 min
  remSleepInSeconds: 7200, // 120 min
  awakeDurationInSeconds: 1800, // 30 min
  averageSpO2Value: 96.5,
  lowestSpO2Value: 92,
  averageRespirationValue: 15.2,
  overallSleepScore: 82,
};

describe("parseGarminSleep", () => {
  it("converts seconds to minutes", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.durationMinutes).toBe(420); // 25200 / 60
    expect(result.deepMinutes).toBe(90); // 5400 / 60
    expect(result.lightMinutes).toBe(180); // 10800 / 60
    expect(result.remMinutes).toBe(120); // 7200 / 60
    expect(result.awakeMinutes).toBe(30); // 1800 / 60
  });

  it("uses epoch seconds for start/end", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.startedAt).toEqual(new Date(1718409600 * 1000));
    expect(result.endedAt).toEqual(new Date((1718409600 + 25200) * 1000));
  });

  it("uses calendarDate as externalId", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.externalId).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimalSleep: GarminSleepSummary = {
      calendarDate: "2024-06-15",
      startTimeInSeconds: 1718409600,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 25200,
      deepSleepDurationInSeconds: 5400,
      lightSleepDurationInSeconds: 10800,
      remSleepInSeconds: 7200,
      awakeDurationInSeconds: 1800,
    };
    const result = parseGarminSleep(minimalSleep);
    expect(result.durationMinutes).toBe(420);
    expect(result.deepMinutes).toBe(90);
  });
});

// ============================================================
// Daily summary parsing
// ============================================================

const sampleDailySummary: GarminDailySummary = {
  calendarDate: "2024-06-15",
  startTimeInSeconds: 1718409600,
  startTimeOffsetInSeconds: -14400,
  durationInSeconds: 86400,
  steps: 12500,
  distanceInMeters: 9500,
  activeKilocalories: 450,
  bmrKilocalories: 1800,
  restingHeartRateInBeatsPerMinute: 58,
  maxHeartRateInBeatsPerMinute: 165,
  averageStressLevel: 35,
  maxStressLevel: 85,
  bodyBatteryChargedValue: 65,
  bodyBatteryDrainedValue: 48,
  averageSpo2: 97.1,
  lowestSpo2: 93,
  respirationAvg: 15.5,
  floorsClimbed: 12,
  moderateIntensityDurationInSeconds: 1800, // 30 min
  vigorousIntensityDurationInSeconds: 900, // 15 min
};

describe("parseGarminDailySummary", () => {
  it("maps steps", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.steps).toBe(12500);
  });

  it("converts distance from meters to km", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.distanceKm).toBeCloseTo(9.5);
  });

  it("maps active and basal calories", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.activeEnergyKcal).toBe(450);
    expect(result.basalEnergyKcal).toBe(1800);
  });

  it("maps resting heart rate", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.restingHr).toBe(58);
  });

  it("maps SpO2 average", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.spo2Avg).toBeCloseTo(97.1);
  });

  it("maps respiratory rate", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.respiratoryRateAvg).toBeCloseTo(15.5);
  });

  it("maps floors climbed to flights climbed", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.flightsClimbed).toBe(12);
  });

  it("converts intensity seconds to exercise minutes", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.exerciseMinutes).toBe(45); // (1800 + 900) / 60
  });

  it("uses calendarDate as date", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.date).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimal: GarminDailySummary = {
      calendarDate: "2024-06-15",
      startTimeInSeconds: 1718409600,
      startTimeOffsetInSeconds: -14400,
      durationInSeconds: 86400,
      steps: 5000,
      distanceInMeters: 3800,
      activeKilocalories: 200,
      bmrKilocalories: 1700,
    };
    const result = parseGarminDailySummary(minimal);
    expect(result.steps).toBe(5000);
    expect(result.restingHr).toBeUndefined();
    expect(result.spo2Avg).toBeUndefined();
    expect(result.exerciseMinutes).toBeUndefined();
  });

  it("handles only moderate intensity seconds", () => {
    const withModerate: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityDurationInSeconds: 1500, // 25 min
      vigorousIntensityDurationInSeconds: undefined,
    };
    const result = parseGarminDailySummary(withModerate);
    expect(result.exerciseMinutes).toBe(25);
  });

  it("handles only vigorous intensity seconds", () => {
    const withVigorous: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityDurationInSeconds: undefined,
      vigorousIntensityDurationInSeconds: 1200, // 20 min
    };
    const result = parseGarminDailySummary(withVigorous);
    expect(result.exerciseMinutes).toBe(20);
  });
});

// ============================================================
// Body composition parsing
// ============================================================

const sampleBodyComp: GarminBodyComposition = {
  measurementTimeInSeconds: 1718438400, // epoch seconds
  weightInGrams: 75500,
  bmi: 23.8,
  bodyFatInPercent: 18.5,
  muscleMassInGrams: 32000,
  boneMassInGrams: 3200,
  bodyWaterInPercent: 55.2,
};

describe("parseGarminBodyComposition", () => {
  it("converts weight from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.weightKg).toBeCloseTo(75.5);
  });

  it("converts muscle mass from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.muscleMassKg).toBeCloseTo(32.0);
  });

  it("converts bone mass from grams to kg", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.boneMassKg).toBeCloseTo(3.2);
  });

  it("passes through body fat percentage", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.bodyFatPct).toBeCloseTo(18.5);
  });

  it("passes through body water percentage", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.waterPct).toBeCloseTo(55.2);
  });

  it("passes through BMI", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.bmi).toBeCloseTo(23.8);
  });

  it("uses measurementTimeInSeconds as externalId", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.externalId).toBe("1718438400");
  });

  it("uses epoch seconds for recordedAt", () => {
    const result = parseGarminBodyComposition(sampleBodyComp);
    expect(result.recordedAt).toEqual(new Date(1718438400 * 1000));
  });

  it("handles missing optional fields", () => {
    const minimalBodyComp: GarminBodyComposition = {
      measurementTimeInSeconds: 1718438400,
      weightInGrams: 80000,
    };
    const result = parseGarminBodyComposition(minimalBodyComp);
    expect(result.weightKg).toBeCloseTo(80.0);
    expect(result.bodyFatPct).toBeUndefined();
    expect(result.muscleMassKg).toBeUndefined();
    expect(result.boneMassKg).toBeUndefined();
    expect(result.waterPct).toBeUndefined();
    expect(result.bmi).toBeUndefined();
  });
});
