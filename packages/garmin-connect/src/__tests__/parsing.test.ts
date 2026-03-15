import { describe, expect, it } from "vitest";
import {
  parseGarminConnectActivity,
  parseGarminConnectDailySummary,
  parseGarminConnectHrv,
  parseGarminConnectSleep,
  parseGarminConnectWeight,
} from "../parsing.ts";
import type {
  GarminConnectActivity,
  GarminDailyUserSummary,
  GarminHrvData,
  GarminSleepData,
  GarminWeightEntry,
} from "../types.ts";

describe("parseGarminConnectActivity", () => {
  const baseActivity: GarminConnectActivity = {
    activityId: 12345678,
    activityName: "Morning Run",
    activityType: {
      typeId: 1,
      typeKey: "running",
      parentTypeId: 17,
      isHidden: false,
      sortOrder: 3,
    },
    startTimeLocal: "2024-01-15 07:30:00",
    startTimeGMT: "2024-01-15 12:30:00",
    duration: 3600,
    distance: 10000,
    averageHR: 145,
    maxHR: 175,
    averageSpeed: 2.78,
    maxSpeed: 3.5,
    calories: 650,
    elevationGain: 120,
    elevationLoss: 115,
    avgPower: 250,
    maxPower: 400,
    normPower: 260,
    trainingStressScore: 85,
    aerobicTrainingEffect: 3.5,
    anaerobicTrainingEffect: 1.2,
    vO2MaxValue: 52.3,
  };

  it("parses basic activity fields", () => {
    const parsed = parseGarminConnectActivity(baseActivity);
    expect(parsed.externalId).toBe("12345678");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.startedAt).toEqual(new Date("2024-01-15T12:30:00.000Z"));
    expect(parsed.endedAt).toEqual(new Date("2024-01-15T13:30:00.000Z"));
  });

  it("includes training metrics", () => {
    const parsed = parseGarminConnectActivity(baseActivity);
    expect(parsed.distanceMeters).toBe(10000);
    expect(parsed.averageHeartRate).toBe(145);
    expect(parsed.maxHeartRate).toBe(175);
    expect(parsed.averagePower).toBe(250);
    expect(parsed.maxPower).toBe(400);
    expect(parsed.normalizedPower).toBe(260);
    expect(parsed.trainingStressScore).toBe(85);
    expect(parsed.aerobicTrainingEffect).toBe(3.5);
    expect(parsed.anaerobicTrainingEffect).toBe(1.2);
    expect(parsed.vo2Max).toBe(52.3);
  });

  it("preserves raw activity data", () => {
    const parsed = parseGarminConnectActivity(baseActivity);
    expect(parsed.raw).toBe(baseActivity);
  });

  it("handles missing optional fields", () => {
    const minimal: GarminConnectActivity = {
      activityId: 99999,
      activityName: "Other Activity",
      activityType: {
        typeId: 99,
        typeKey: "unknown_sport",
        parentTypeId: 0,
        isHidden: false,
        sortOrder: 99,
      },
      startTimeLocal: "2024-01-15 08:00:00",
      startTimeGMT: "2024-01-15 13:00:00",
      duration: 1800,
    };
    const parsed = parseGarminConnectActivity(minimal);
    expect(parsed.activityType).toBe("other");
    expect(parsed.distanceMeters).toBeUndefined();
    expect(parsed.averageHeartRate).toBeUndefined();
    expect(parsed.averagePower).toBeUndefined();
    expect(parsed.trainingStressScore).toBeUndefined();
  });

  it("maps various activity types correctly", () => {
    const types: Array<[string, string]> = [
      ["running", "running"],
      ["trail_running", "running"],
      ["cycling", "cycling"],
      ["mountain_biking", "cycling"],
      ["indoor_cycling", "cycling"],
      ["lap_swimming", "swimming"],
      ["strength_training", "strength"],
      ["yoga", "yoga"],
      ["hiking", "hiking"],
      ["rowing", "rowing"],
      ["tennis", "tennis"],
      ["resort_skiing_snowboarding_ws", "skiing"],
    ];
    for (const [typeKey, expected] of types) {
      const act = {
        ...baseActivity,
        activityType: { ...baseActivity.activityType, typeKey },
      };
      expect(parseGarminConnectActivity(act).activityType).toBe(expected);
    }
  });
});

describe("parseGarminConnectSleep", () => {
  const baseSleep: GarminSleepData = {
    dailySleepDTO: {
      calendarDate: "2024-01-15",
      sleepStartTimestampGMT: 1705276800000,
      sleepEndTimestampGMT: 1705305600000,
      sleepTimeSeconds: 25200,
      deepSleepSeconds: 5400,
      lightSleepSeconds: 10800,
      remSleepSeconds: 7200,
      awakeSleepSeconds: 1800,
      averageSpO2Value: 96.5,
      averageRespirationValue: 15.2,
      sleepScores: {
        overall: { value: 82, qualifierKey: "GOOD" },
        qualityScore: 78,
        recoveryScore: 85,
        durationScore: 80,
      },
    },
  };

  it("parses sleep durations to minutes", () => {
    const parsed = parseGarminConnectSleep(baseSleep);
    expect(parsed.externalId).toBe("2024-01-15");
    expect(parsed.durationMinutes).toBe(420);
    expect(parsed.deepMinutes).toBe(90);
    expect(parsed.lightMinutes).toBe(180);
    expect(parsed.remMinutes).toBe(120);
    expect(parsed.awakeMinutes).toBe(30);
  });

  it("includes sleep score and SpO2", () => {
    const parsed = parseGarminConnectSleep(baseSleep);
    expect(parsed.sleepScore).toBe(82);
    expect(parsed.averageSpO2).toBe(96.5);
    expect(parsed.averageRespiration).toBe(15.2);
  });

  it("handles missing sleep scores", () => {
    const noScores: GarminSleepData = {
      dailySleepDTO: {
        ...baseSleep.dailySleepDTO,
        sleepScores: undefined,
        averageSpO2Value: undefined,
      },
    };
    const parsed = parseGarminConnectSleep(noScores);
    expect(parsed.sleepScore).toBeUndefined();
    expect(parsed.averageSpO2).toBeUndefined();
  });
});

describe("parseGarminConnectDailySummary", () => {
  const baseSummary: GarminDailyUserSummary = {
    calendarDate: "2024-01-15",
    totalSteps: 12500,
    totalDistanceMeters: 9500,
    activeKilocalories: 450,
    bmrKilocalories: 1800,
    restingHeartRate: 58,
    maxHeartRate: 165,
    averageStressLevel: 35,
    bodyBatteryChargedValue: 65,
    bodyBatteryDrainedValue: 40,
    bodyBatteryHighestValue: 90,
    bodyBatteryLowestValue: 25,
    floorsAscended: 12,
    moderateIntensityMinutes: 30,
    vigorousIntensityMinutes: 15,
  };

  it("parses basic daily metrics", () => {
    const parsed = parseGarminConnectDailySummary(baseSummary);
    expect(parsed.date).toBe("2024-01-15");
    expect(parsed.steps).toBe(12500);
    expect(parsed.distanceKm).toBe(9.5);
    expect(parsed.activeEnergyKcal).toBe(450);
    expect(parsed.basalEnergyKcal).toBe(1800);
  });

  it("includes body battery and stress", () => {
    const parsed = parseGarminConnectDailySummary(baseSummary);
    expect(parsed.bodyBatteryCharged).toBe(65);
    expect(parsed.bodyBatteryDrained).toBe(40);
    expect(parsed.bodyBatteryHighest).toBe(90);
    expect(parsed.bodyBatteryLowest).toBe(25);
    expect(parsed.averageStressLevel).toBe(35);
  });

  it("includes intensity minutes", () => {
    const parsed = parseGarminConnectDailySummary(baseSummary);
    expect(parsed.moderateIntensityMinutes).toBe(30);
    expect(parsed.vigorousIntensityMinutes).toBe(15);
  });
});

describe("parseGarminConnectWeight", () => {
  const baseWeight: GarminWeightEntry = {
    samplePk: 1705300000,
    date: 1705300000000,
    calendarDate: "2024-01-15",
    version: 1,
    weight: 82500,
    bmi: 25.1,
    bodyFat: 18.5,
    bodyWater: 55.2,
    boneMass: 3200,
    muscleMass: 35600,
    visceralFat: 8,
    metabolicAge: 32,
  };

  it("converts weight from grams to kg", () => {
    const parsed = parseGarminConnectWeight(baseWeight);
    expect(parsed.weightKg).toBe(82.5);
  });

  it("converts muscle and bone mass from grams to kg", () => {
    const parsed = parseGarminConnectWeight(baseWeight);
    expect(parsed.muscleMassKg).toBe(35.6);
    expect(parsed.boneMassKg).toBe(3.2);
  });

  it("preserves percentage and index values", () => {
    const parsed = parseGarminConnectWeight(baseWeight);
    expect(parsed.bmi).toBe(25.1);
    expect(parsed.bodyFatPct).toBe(18.5);
    expect(parsed.waterPct).toBe(55.2);
    expect(parsed.visceralFat).toBe(8);
    expect(parsed.metabolicAge).toBe(32);
  });

  it("handles missing optional fields", () => {
    const minimal: GarminWeightEntry = {
      samplePk: 123,
      date: 1705300000000,
      calendarDate: "2024-01-15",
      version: 1,
      weight: 75000,
    };
    const parsed = parseGarminConnectWeight(minimal);
    expect(parsed.weightKg).toBe(75);
    expect(parsed.muscleMassKg).toBeUndefined();
    expect(parsed.boneMassKg).toBeUndefined();
    expect(parsed.visceralFat).toBeUndefined();
  });
});

describe("parseGarminConnectHrv", () => {
  it("parses HRV with summary", () => {
    const data: GarminHrvData = {
      calendarDate: "2024-01-15",
      weeklyAvg: 45,
      lastNight: 52,
      lastNightAvg: 48,
      lastNight5MinHigh: 65,
      hrvSummary: {
        weeklyAvg: 46,
        lastNight: 53,
        lastNightAvg: 49,
        lastNight5MinHigh: 66,
        status: "BALANCED",
      },
    };
    const parsed = parseGarminConnectHrv(data);
    expect(parsed.date).toBe("2024-01-15");
    // Prefers summary values over top-level
    expect(parsed.weeklyAvg).toBe(46);
    expect(parsed.lastNight).toBe(53);
    expect(parsed.lastNightAvg).toBe(49);
    expect(parsed.lastNight5MinHigh).toBe(66);
    expect(parsed.status).toBe("BALANCED");
  });

  it("falls back to top-level values when summary is missing", () => {
    const data: GarminHrvData = {
      calendarDate: "2024-01-15",
      weeklyAvg: 45,
      lastNight: 52,
      lastNightAvg: 48,
      lastNight5MinHigh: 65,
    };
    const parsed = parseGarminConnectHrv(data);
    expect(parsed.weeklyAvg).toBe(45);
    expect(parsed.lastNight).toBe(52);
    expect(parsed.status).toBeUndefined();
  });
});
