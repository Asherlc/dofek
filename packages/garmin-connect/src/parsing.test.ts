import { describe, expect, it } from "vitest";
import {
  mapConnectActivityType,
  parseActivityDetail,
  parseConnectActivity,
  parseConnectDailySummary,
  parseConnectSleep,
  parseHeartRateTimeSeries,
  parseHrvSummary,
  parseStressTimeSeries,
  parseTrainingReadiness,
  parseTrainingStatus,
} from "./parsing.ts";
import type {
  ConnectActivityDetail,
  ConnectActivitySummary,
  ConnectDailySummary,
  ConnectSleepData,
  DailyHeartRate,
  DailyStress,
  HrvSummary,
  TrainingReadiness,
  TrainingStatus,
} from "./types.ts";

describe("mapConnectActivityType", () => {
  it("maps running types", () => {
    expect(mapConnectActivityType("running")).toBe("running");
    expect(mapConnectActivityType("trail_running")).toBe("running");
    expect(mapConnectActivityType("treadmill_running")).toBe("running");
  });

  it("maps cycling types", () => {
    expect(mapConnectActivityType("cycling")).toBe("cycling");
    expect(mapConnectActivityType("mountain_biking")).toBe("mountain_biking");
    expect(mapConnectActivityType("indoor_cycling")).toBe("indoor_cycling");
    expect(mapConnectActivityType("gravel_cycling")).toBe("gravel_cycling");
  });

  it("maps swimming types", () => {
    expect(mapConnectActivityType("swimming")).toBe("swimming");
    expect(mapConnectActivityType("lap_swimming")).toBe("swimming");
    expect(mapConnectActivityType("open_water_swimming")).toBe("swimming");
  });

  it("maps strength and cardio", () => {
    expect(mapConnectActivityType("strength_training")).toBe("strength");
    expect(mapConnectActivityType("indoor_cardio")).toBe("cardio");
    expect(mapConnectActivityType("yoga")).toBe("yoga");
  });

  it("returns 'other' for unknown types", () => {
    expect(mapConnectActivityType("unknown_sport")).toBe("other");
    expect(mapConnectActivityType("")).toBe("other");
  });
});

describe("parseConnectActivity", () => {
  const sampleActivity: ConnectActivitySummary = {
    activityId: 12345678,
    activityName: "Morning Run",
    activityType: {
      typeId: 1,
      typeKey: "running",
    },
    startTimeGMT: "2024-01-15T07:30:00.000",
    startTimeLocal: "2024-01-15T09:30:00.000",
    distance: 10500.5,
    duration: 3600000, // 1 hour in ms
    averageHR: 145,
    maxHR: 172,
    averageSpeed: 2.917,
    averagePower: undefined,
    calories: 650,
    elevationGain: 120,
    elevationLoss: 115,
  };

  it("parses activity ID as string", () => {
    const parsed = parseConnectActivity(sampleActivity);
    expect(parsed.externalId).toBe("12345678");
  });

  it("maps activity type from typeKey", () => {
    const parsed = parseConnectActivity(sampleActivity);
    expect(parsed.activityType).toBe("running");
  });

  it("preserves activity name", () => {
    const parsed = parseConnectActivity(sampleActivity);
    expect(parsed.name).toBe("Morning Run");
  });

  it("parses start time from GMT string", () => {
    const parsed = parseConnectActivity(sampleActivity);
    expect(parsed.startedAt).toBeInstanceOf(Date);
    expect(parsed.startedAt.getUTCHours()).toBe(7);
    expect(parsed.startedAt.getUTCMinutes()).toBe(30);
  });

  it("calculates end time from start + duration (ms)", () => {
    const parsed = parseConnectActivity(sampleActivity);
    const durationMs = parsed.endedAt.getTime() - parsed.startedAt.getTime();
    expect(durationMs).toBe(3600000);
  });

  it("preserves raw data", () => {
    const parsed = parseConnectActivity(sampleActivity);
    expect(parsed.raw).toBe(sampleActivity);
    expect(parsed.raw.averageHR).toBe(145);
  });
});

describe("parseConnectSleep", () => {
  const sampleSleep: ConnectSleepData = {
    dailySleepDTO: {
      id: 98765,
      userProfilePK: 111,
      calendarDate: "2024-01-15",
      sleepTimeSeconds: 28800, // 8 hours
      sleepStartTimestampGMT: 1705276800000, // epoch ms
      sleepEndTimestampGMT: 1705305600000,
      deepSleepSeconds: 5400, // 90 min
      lightSleepSeconds: 14400, // 240 min
      remSleepSeconds: 7200, // 120 min
      awakeSleepSeconds: 1800, // 30 min
      averageSpO2Value: 96.5,
      averageRespirationValue: 15.2,
      awakeningCount: 3,
      sleepScores: {
        overall: { value: 82, qualifierKey: "GOOD" },
        deep: { value: 75, qualifierKey: "FAIR" },
        rem: { value: 88, qualifierKey: "GOOD" },
      },
    },
  };

  it("parses sleep ID as external ID", () => {
    const parsed = parseConnectSleep(sampleSleep);
    expect(parsed?.externalId).toBe("98765");
  });

  it("converts seconds to minutes", () => {
    const parsed = parseConnectSleep(sampleSleep);
    expect(parsed?.durationMinutes).toBe(480);
    expect(parsed?.deepMinutes).toBe(90);
    expect(parsed?.lightMinutes).toBe(240);
    expect(parsed?.remMinutes).toBe(120);
    expect(parsed?.awakeMinutes).toBe(30);
  });

  it("parses sleep score from sleepScores.overall", () => {
    const parsed = parseConnectSleep(sampleSleep);
    expect(parsed?.sleepScore).toBe(82);
  });

  it("parses SpO2 and respiration", () => {
    const parsed = parseConnectSleep(sampleSleep);
    expect(parsed?.averageSpO2).toBe(96.5);
    expect(parsed?.averageRespiration).toBe(15.2);
  });

  it("returns null for sleep without timestamps", () => {
    const noTimestamps: ConnectSleepData = {
      dailySleepDTO: {
        id: 99999,
        userProfilePK: 111,
        calendarDate: "2024-01-15",
      },
    };
    expect(parseConnectSleep(noTimestamps)).toBeNull();
  });
});

describe("parseConnectDailySummary", () => {
  const sampleSummary: ConnectDailySummary = {
    calendarDate: "2024-01-15",
    totalSteps: 12500,
    totalDistanceMeters: 9800,
    activeKilocalories: 450,
    bmrKilocalories: 1800,
    restingHeartRate: 58,
    averageSpo2: 97,
    floorsAscended: 12,
    moderateIntensityMinutes: 30,
    vigorousIntensityMinutes: 15,
    privacyProtected: false,
  };

  it("converts distance from meters to km", () => {
    const parsed = parseConnectDailySummary(sampleSummary);
    expect(parsed.distanceKm).toBeCloseTo(9.8, 1);
  });

  it("sums exercise minutes from moderate + vigorous", () => {
    const parsed = parseConnectDailySummary(sampleSummary);
    expect(parsed.exerciseMinutes).toBe(45);
  });

  it("preserves direct values", () => {
    const parsed = parseConnectDailySummary(sampleSummary);
    expect(parsed.date).toBe("2024-01-15");
    expect(parsed.steps).toBe(12500);
    expect(parsed.restingHr).toBe(58);
    expect(parsed.spo2Avg).toBe(97);
    expect(parsed.flightsClimbed).toBe(12);
  });

  it("handles missing optional fields", () => {
    const minimal: ConnectDailySummary = {
      calendarDate: "2024-01-15",
      totalSteps: 0,
      totalDistanceMeters: 0,
      activeKilocalories: 0,
      bmrKilocalories: 0,
      privacyProtected: false,
    };
    const parsed = parseConnectDailySummary(minimal);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.exerciseMinutes).toBeUndefined();
    expect(parsed.flightsClimbed).toBeUndefined();
  });
});

describe("parseTrainingStatus", () => {
  const sampleStatus: TrainingStatus = {
    userId: 111,
    trainingStatusMessage: "PRODUCTIVE",
    acuteTrainingLoad: 850,
    chronicTrainingLoad: 720,
    trainingLoadBalance: 130,
    trainingLoadRatio: 1.18,
    latestRunVo2Max: 52.5,
    latestCycleVo2Max: 48.3,
    latestFitnessAge: 28,
  };

  it("parses training load values", () => {
    const parsed = parseTrainingStatus(sampleStatus, "2024-01-15");
    expect(parsed.acuteTrainingLoad).toBe(850);
    expect(parsed.chronicTrainingLoad).toBe(720);
    expect(parsed.trainingLoadBalance).toBe(130);
    expect(parsed.trainingLoadRatio).toBe(1.18);
  });

  it("parses VO2 max separately for running and cycling", () => {
    const parsed = parseTrainingStatus(sampleStatus, "2024-01-15");
    expect(parsed.vo2MaxRunning).toBe(52.5);
    expect(parsed.vo2MaxCycling).toBe(48.3);
  });

  it("falls back to generic VO2 max if sport-specific not available", () => {
    const generic: TrainingStatus = {
      userId: 111,
      latestVo2Max: 50.0,
    };
    const parsed = parseTrainingStatus(generic, "2024-01-15");
    expect(parsed.vo2MaxRunning).toBe(50.0);
  });

  it("parses fitness age", () => {
    const parsed = parseTrainingStatus(sampleStatus, "2024-01-15");
    expect(parsed.fitnessAge).toBe(28);
  });

  it("parses status message", () => {
    const parsed = parseTrainingStatus(sampleStatus, "2024-01-15");
    expect(parsed.statusMessage).toBe("PRODUCTIVE");
  });
});

describe("parseTrainingReadiness", () => {
  const sampleReadiness: TrainingReadiness = {
    calendarDate: "2024-01-15",
    score: 75,
    level: "MODERATE",
    sleepScore: 82,
    recoveryScore: 70,
    acuteTrainingLoadScore: 65,
    hrvScore: 80,
  };

  it("parses all readiness components", () => {
    const parsed = parseTrainingReadiness(sampleReadiness);
    expect(parsed.date).toBe("2024-01-15");
    expect(parsed.score).toBe(75);
    expect(parsed.level).toBe("MODERATE");
    expect(parsed.sleepScore).toBe(82);
    expect(parsed.recoveryScore).toBe(70);
    expect(parsed.acuteTrainingLoadScore).toBe(65);
    expect(parsed.hrvScore).toBe(80);
  });
});

describe("parseHrvSummary", () => {
  const sampleHrv: HrvSummary = {
    calendarDate: "2024-01-15",
    weeklyAvg: 45,
    lastNight: 48,
    lastNightAvg: 42,
    lastNight5MinHigh: 65,
    status: "BALANCED",
    baseline: {
      lowUpper: 30,
      balancedLow: 35,
      balancedUpper: 55,
    },
  };

  it("parses HRV values", () => {
    const parsed = parseHrvSummary(sampleHrv);
    expect(parsed.date).toBe("2024-01-15");
    expect(parsed.weeklyAvg).toBe(45);
    expect(parsed.lastNight).toBe(48);
    expect(parsed.lastNightAvg).toBe(42);
    expect(parsed.lastNight5MinHigh).toBe(65);
  });

  it("parses baseline ranges", () => {
    const parsed = parseHrvSummary(sampleHrv);
    expect(parsed.baselineLow).toBe(30);
    expect(parsed.baselineBalancedLow).toBe(35);
    expect(parsed.baselineBalancedUpper).toBe(55);
  });

  it("parses status", () => {
    const parsed = parseHrvSummary(sampleHrv);
    expect(parsed.status).toBe("BALANCED");
  });
});

describe("parseStressTimeSeries", () => {
  const sampleStress: DailyStress = {
    calendarDate: "2024-01-15",
    maxStressLevel: 85,
    avgStressLevel: 35,
    stressValuesArray: [
      [1705276800000, 25],
      [1705276860000, 30],
      [1705276920000, -1], // rest state, should be filtered
      [1705276980000, 45],
      [1705277040000, -2], // activity state, should be filtered
    ],
  };

  it("filters out negative stress values (rest/activity states)", () => {
    const parsed = parseStressTimeSeries(sampleStress);
    expect(parsed.samples).toHaveLength(3);
    expect(parsed.samples.every((s) => s.stressLevel >= 0)).toBe(true);
  });

  it("converts timestamps to Date objects", () => {
    const parsed = parseStressTimeSeries(sampleStress);
    expect(parsed.samples[0]?.timestamp).toBeInstanceOf(Date);
    expect(parsed.samples[0]?.timestamp.getTime()).toBe(1705276800000);
  });

  it("preserves summary values", () => {
    const parsed = parseStressTimeSeries(sampleStress);
    expect(parsed.avgStressLevel).toBe(35);
    expect(parsed.maxStressLevel).toBe(85);
  });
});

describe("parseHeartRateTimeSeries", () => {
  const sampleHr: DailyHeartRate = {
    userProfilePK: 111,
    calendarDate: "2024-01-15",
    startTimestampGMT: "2024-01-15T00:00:00.000",
    endTimestampGMT: "2024-01-15T23:59:59.000",
    startTimestampLocal: "2024-01-15T02:00:00.000",
    endTimestampLocal: "2024-01-16T01:59:59.000",
    maxHeartRate: 172,
    minHeartRate: 48,
    restingHeartRate: 58,
    lastSevenDaysAvgRestingHeartRate: 57,
    heartRateValues: [
      [1705276800000, 55],
      [1705276860000, null], // missing value, should be filtered
      [1705276920000, 58],
      [1705276980000, 62],
    ],
  };

  it("filters out null heart rate values", () => {
    const parsed = parseHeartRateTimeSeries(sampleHr);
    expect(parsed.samples).toHaveLength(3);
  });

  it("preserves summary values", () => {
    const parsed = parseHeartRateTimeSeries(sampleHr);
    expect(parsed.restingHeartRate).toBe(58);
    expect(parsed.minHeartRate).toBe(48);
    expect(parsed.maxHeartRate).toBe(172);
  });

  it("converts timestamps to Date objects", () => {
    const parsed = parseHeartRateTimeSeries(sampleHr);
    expect(parsed.samples[0]?.timestamp).toBeInstanceOf(Date);
    expect(parsed.samples[0]?.heartRate).toBe(55);
  });
});

describe("parseActivityDetail", () => {
  const sampleDetail: ConnectActivityDetail = {
    activityId: 12345678,
    measurementCount: 3,
    metricsCount: 3,
    metricDescriptors: [
      { metricsIndex: 0, key: "directTimestamp" },
      { metricsIndex: 1, key: "directHeartRate" },
      { metricsIndex: 2, key: "directPower" },
    ],
    activityDetailMetrics: [
      { metrics: [1705276800000, 145, 250] },
      { metrics: [1705276801000, 148, 260] },
      { metrics: [1705276802000, 150, null] },
    ],
  };

  it("maps metric descriptors to keys", () => {
    const parsed = parseActivityDetail(sampleDetail);
    expect(parsed.metricKeys).toEqual(["directTimestamp", "directHeartRate", "directPower"]);
  });

  it("creates samples with named keys from descriptors", () => {
    const parsed = parseActivityDetail(sampleDetail);
    expect(parsed.samples).toHaveLength(3);
    expect(parsed.samples[0]).toEqual({
      directTimestamp: 1705276800000,
      directHeartRate: 145,
      directPower: 250,
    });
  });

  it("preserves null values in samples", () => {
    const parsed = parseActivityDetail(sampleDetail);
    expect(parsed.samples[2]?.directPower).toBeNull();
  });

  it("includes activity ID", () => {
    const parsed = parseActivityDetail(sampleDetail);
    expect(parsed.activityId).toBe(12345678);
  });
});
