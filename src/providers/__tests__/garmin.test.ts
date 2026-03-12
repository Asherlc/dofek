import { describe, expect, it } from "vitest";
import {
  type GarminActivity,
  type GarminDailySummary,
  type GarminSleepResponse,
  type GarminWeightEntry,
  mapGarminActivityType,
  parseGarminActivity,
  parseGarminDailySummary,
  parseGarminSleep,
  parseGarminWeight,
} from "../garmin.ts";

// ============================================================
// Activity type mapping
// ============================================================

describe("mapGarminActivityType", () => {
  it("maps running types", () => {
    expect(mapGarminActivityType("running")).toBe("running");
    expect(mapGarminActivityType("trail_running")).toBe("running");
    expect(mapGarminActivityType("treadmill_running")).toBe("running");
    expect(mapGarminActivityType("track_running")).toBe("running");
  });

  it("maps cycling types", () => {
    expect(mapGarminActivityType("cycling")).toBe("cycling");
    expect(mapGarminActivityType("mountain_biking")).toBe("cycling");
    expect(mapGarminActivityType("road_biking")).toBe("cycling");
    expect(mapGarminActivityType("indoor_cycling")).toBe("cycling");
    expect(mapGarminActivityType("gravel_cycling")).toBe("cycling");
    expect(mapGarminActivityType("virtual_ride")).toBe("cycling");
  });

  it("maps swimming types", () => {
    expect(mapGarminActivityType("swimming")).toBe("swimming");
    expect(mapGarminActivityType("lap_swimming")).toBe("swimming");
    expect(mapGarminActivityType("open_water_swimming")).toBe("swimming");
  });

  it("maps walking and hiking", () => {
    expect(mapGarminActivityType("walking")).toBe("walking");
    expect(mapGarminActivityType("hiking")).toBe("hiking");
  });

  it("maps strength training", () => {
    expect(mapGarminActivityType("strength_training")).toBe("strength");
    expect(mapGarminActivityType("indoor_cardio")).toBe("cardio");
  });

  it("maps yoga and other fitness types", () => {
    expect(mapGarminActivityType("yoga")).toBe("yoga");
    expect(mapGarminActivityType("pilates")).toBe("pilates");
    expect(mapGarminActivityType("elliptical")).toBe("elliptical");
    expect(mapGarminActivityType("rowing")).toBe("rowing");
  });

  it("returns 'other' for unknown types", () => {
    expect(mapGarminActivityType("paragliding")).toBe("other");
    expect(mapGarminActivityType("")).toBe("other");
  });
});

// ============================================================
// Activity parsing
// ============================================================

const sampleActivity: GarminActivity = {
  activityId: 12345678,
  activityName: "Morning Run",
  activityType: { typeKey: "running", typeId: 1 },
  startTimeLocal: "2024-06-15 10:30:00",
  startTimeGMT: "2024-06-15 14:30:00",
  duration: 3600,
  distance: 10000,
  averageHR: 155,
  maxHR: 185,
  averageSpeed: 2.78,
  calories: 750,
  elevationGain: 120.5,
  elevationLoss: 115.2,
  averageRunCadence: 170,
  description: "Easy morning run",
};

describe("parseGarminActivity", () => {
  it("maps all fields correctly", () => {
    const result = parseGarminActivity(sampleActivity);
    expect(result.externalId).toBe("12345678");
    expect(result.activityType).toBe("running");
    expect(result.name).toBe("Morning Run");
    expect(result.startedAt).toEqual(new Date("2024-06-15T14:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2024-06-15T15:30:00Z")); // +3600s
    expect(result.notes).toBe("Easy morning run");
    expect(result.raw).toBe(sampleActivity);
  });

  it("uses GMT start time", () => {
    const result = parseGarminActivity(sampleActivity);
    // GMT time, not local
    expect(result.startedAt.toISOString()).toBe("2024-06-15T14:30:00.000Z");
  });

  it("computes endedAt from startedAt + duration", () => {
    const result = parseGarminActivity(sampleActivity);
    const expectedEnd = new Date(result.startedAt.getTime() + 3600 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("handles missing optional fields", () => {
    const minimal: GarminActivity = {
      activityId: 99999,
      activityName: "Walk",
      activityType: { typeKey: "walking", typeId: 9 },
      startTimeLocal: "2024-06-15 08:00:00",
      startTimeGMT: "2024-06-15 12:00:00",
      duration: 1800,
      distance: 2000,
      calories: 150,
    };
    const result = parseGarminActivity(minimal);
    expect(result.externalId).toBe("99999");
    expect(result.activityType).toBe("walking");
    expect(result.notes).toBeUndefined();
  });

  it("handles zero duration", () => {
    const zeroDuration = { ...sampleActivity, duration: 0 };
    const result = parseGarminActivity(zeroDuration);
    expect(result.endedAt).toEqual(result.startedAt);
  });
});

// ============================================================
// Sleep parsing
// ============================================================

const sampleSleep: GarminSleepResponse = {
  dailySleepDTO: {
    calendarDate: "2024-06-15",
    sleepStartTimestampGMT: 1718409600000, // 2024-06-15T00:00:00Z
    sleepEndTimestampGMT: 1718438400000, // 2024-06-15T08:00:00Z
    sleepTimeSeconds: 25200, // 7 hours
    deepSleepSeconds: 5400, // 90 min
    lightSleepSeconds: 10800, // 180 min
    remSleepSeconds: 7200, // 120 min
    awakeSleepSeconds: 1800, // 30 min
    averageSpO2Value: 96.5,
    lowestSpO2Value: 92,
    averageRespirationValue: 15.2,
    sleepScores: { overall: { value: 82 } },
  },
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

  it("uses GMT timestamps for start/end", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.startedAt).toEqual(new Date(1718409600000));
    expect(result.endedAt).toEqual(new Date(1718438400000));
  });

  it("uses calendarDate as externalId", () => {
    const result = parseGarminSleep(sampleSleep);
    expect(result.externalId).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimalSleep: GarminSleepResponse = {
      dailySleepDTO: {
        calendarDate: "2024-06-15",
        sleepStartTimestampGMT: 1718409600000,
        sleepEndTimestampGMT: 1718438400000,
        sleepTimeSeconds: 25200,
        deepSleepSeconds: 5400,
        lightSleepSeconds: 10800,
        remSleepSeconds: 7200,
        awakeSleepSeconds: 1800,
      },
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
  totalSteps: 12500,
  totalDistanceMeters: 9500,
  activeKilocalories: 450,
  bmrKilocalories: 1800,
  restingHeartRate: 58,
  maxHeartRate: 165,
  averageStressLevel: 35,
  maxStressLevel: 85,
  bodyBatteryChargedValue: 65,
  bodyBatteryDrainedValue: 48,
  averageSpo2: 97.1,
  lowestSpo2: 93,
  respirationAvg: 15.5,
  floorsAscended: 12,
  moderateIntensityMinutes: 30,
  vigorousIntensityMinutes: 15,
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

  it("maps floors ascended to flights climbed", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.flightsClimbed).toBe(12);
  });

  it("sums moderate + vigorous minutes into exercise minutes", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.exerciseMinutes).toBe(45); // 30 + 15
  });

  it("uses calendarDate as date", () => {
    const result = parseGarminDailySummary(sampleDailySummary);
    expect(result.date).toBe("2024-06-15");
  });

  it("handles missing optional fields", () => {
    const minimal: GarminDailySummary = {
      calendarDate: "2024-06-15",
      totalSteps: 5000,
      totalDistanceMeters: 3800,
      activeKilocalories: 200,
      bmrKilocalories: 1700,
    };
    const result = parseGarminDailySummary(minimal);
    expect(result.steps).toBe(5000);
    expect(result.restingHr).toBeUndefined();
    expect(result.spo2Avg).toBeUndefined();
    expect(result.exerciseMinutes).toBeUndefined();
  });

  it("handles only moderate minutes", () => {
    const withModerate: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityMinutes: 25,
      vigorousIntensityMinutes: undefined,
    };
    const result = parseGarminDailySummary(withModerate);
    expect(result.exerciseMinutes).toBe(25);
  });

  it("handles only vigorous minutes", () => {
    const withVigorous: GarminDailySummary = {
      ...sampleDailySummary,
      moderateIntensityMinutes: undefined,
      vigorousIntensityMinutes: 20,
    };
    const result = parseGarminDailySummary(withVigorous);
    expect(result.exerciseMinutes).toBe(20);
  });
});

// ============================================================
// Weight / body composition parsing
// ============================================================

const sampleWeight: GarminWeightEntry = {
  samplePk: 9876543,
  date: 1718438400000, // ms epoch
  calendarDate: "2024-06-15",
  weight: 75500, // grams
  bmi: 23.8,
  bodyFat: 18.5,
  muscleMass: 32000, // grams
  boneMass: 3200, // grams
  bodyWater: 55.2,
};

describe("parseGarminWeight", () => {
  it("converts weight from grams to kg", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.weightKg).toBeCloseTo(75.5);
  });

  it("converts muscle mass from grams to kg", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.muscleMassKg).toBeCloseTo(32.0);
  });

  it("converts bone mass from grams to kg", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.boneMassKg).toBeCloseTo(3.2);
  });

  it("passes through body fat percentage", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.bodyFatPct).toBeCloseTo(18.5);
  });

  it("passes through body water percentage", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.waterPct).toBeCloseTo(55.2);
  });

  it("passes through BMI", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.bmi).toBeCloseTo(23.8);
  });

  it("uses samplePk as externalId", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.externalId).toBe("9876543");
  });

  it("uses ms epoch date for recordedAt", () => {
    const result = parseGarminWeight(sampleWeight);
    expect(result.recordedAt).toEqual(new Date(1718438400000));
  });

  it("handles missing optional fields", () => {
    const minimalWeight: GarminWeightEntry = {
      samplePk: 1111,
      date: 1718438400000,
      calendarDate: "2024-06-15",
      weight: 80000,
    };
    const result = parseGarminWeight(minimalWeight);
    expect(result.weightKg).toBeCloseTo(80.0);
    expect(result.bodyFatPct).toBeUndefined();
    expect(result.muscleMassKg).toBeUndefined();
    expect(result.boneMassKg).toBeUndefined();
    expect(result.waterPct).toBeUndefined();
    expect(result.bmi).toBeUndefined();
  });
});
