import { describe, expect, it } from "vitest";
import {
  type FitbitActivity,
  type FitbitDailySummary,
  type FitbitSleepLog,
  type FitbitWeightLog,
  mapFitbitActivityType,
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "./fitbit.ts";

// ============================================================
// Sample API responses
// ============================================================

const sampleActivity: FitbitActivity = {
  logId: 12345678,
  activityName: "Run",
  activityTypeId: 90009,
  startTime: "08:30",
  activeDuration: 3600000, // 60 min in ms
  calories: 450,
  distance: 10.5,
  distanceUnit: "Kilometer",
  steps: 8500,
  averageHeartRate: 155,
  heartRateZones: [
    { name: "Out of Range", min: 30, max: 100, minutes: 2 },
    { name: "Fat Burn", min: 100, max: 140, minutes: 10 },
    { name: "Cardio", min: 140, max: 170, minutes: 35 },
    { name: "Peak", min: 170, max: 220, minutes: 13 },
  ],
  logType: "auto_detected",
  startDate: "2026-03-01",
  tcxLink: "https://api.fitbit.com/1/user/-/activities/12345678.tcx",
};

const sampleSleep: FitbitSleepLog = {
  logId: 87654321,
  dateOfSleep: "2026-03-01",
  startTime: "2026-02-28T23:15:00.000",
  endTime: "2026-03-01T07:00:00.000",
  duration: 27900000, // 7h 45m in ms
  efficiency: 92,
  isMainSleep: true,
  type: "stages",
  levels: {
    summary: {
      deep: { count: 4, minutes: 85, thirtyDayAvgMinutes: 80 },
      light: { count: 28, minutes: 210, thirtyDayAvgMinutes: 200 },
      rem: { count: 6, minutes: 95, thirtyDayAvgMinutes: 90 },
      wake: { count: 30, minutes: 35, thirtyDayAvgMinutes: 40 },
    },
  },
};

const sampleDailySummary: FitbitDailySummary = {
  summary: {
    steps: 12345,
    caloriesOut: 2800,
    activeScore: -1,
    activityCalories: 1200,
    restingHeartRate: 58,
    distances: [
      { activity: "total", distance: 9.5 },
      { activity: "tracker", distance: 9.5 },
    ],
    fairlyActiveMinutes: 25,
    veryActiveMinutes: 45,
    lightlyActiveMinutes: 180,
    sedentaryMinutes: 720,
    floors: 12,
  },
};

const sampleWeightLog: FitbitWeightLog = {
  logId: 55555,
  weight: 82.5,
  bmi: 24.8,
  fat: 18.5,
  date: "2026-03-01",
  time: "07:30:00",
};

// ============================================================
// Tests
// ============================================================

describe("Fitbit Provider", () => {
  describe("mapFitbitActivityType", () => {
    it("maps running activities", () => {
      expect(mapFitbitActivityType("Run", 90009)).toBe("running");
      expect(mapFitbitActivityType("Treadmill", 90009)).toBe("running");
      expect(mapFitbitActivityType("Outdoor Run", 90009)).toBe("running");
    });

    it("maps cycling activities", () => {
      expect(mapFitbitActivityType("Bike", 90001)).toBe("cycling");
      expect(mapFitbitActivityType("Outdoor Bike", 90001)).toBe("cycling");
      expect(mapFitbitActivityType("Spinning", 15000)).toBe("cycling");
    });

    it("maps walking activities", () => {
      expect(mapFitbitActivityType("Walk", 90013)).toBe("walking");
      expect(mapFitbitActivityType("Outdoor Walk", 90013)).toBe("walking");
    });

    it("maps swimming activities", () => {
      expect(mapFitbitActivityType("Swim", 90024)).toBe("swimming");
      expect(mapFitbitActivityType("Swimming", 90024)).toBe("swimming");
    });

    it("maps hiking activities", () => {
      expect(mapFitbitActivityType("Hike", 90012)).toBe("hiking");
      expect(mapFitbitActivityType("Hiking", 90012)).toBe("hiking");
    });

    it("maps yoga activities", () => {
      expect(mapFitbitActivityType("Yoga", 52001)).toBe("yoga");
    });

    it("maps strength/weight training", () => {
      expect(mapFitbitActivityType("Weights", 2030)).toBe("strength");
      expect(mapFitbitActivityType("Weight Training", 2030)).toBe("strength");
    });

    it("maps elliptical activities", () => {
      expect(mapFitbitActivityType("Elliptical", 90017)).toBe("elliptical");
    });

    it("returns other for unknown activities", () => {
      expect(mapFitbitActivityType("Unknown Sport", 99999)).toBe("other");
    });
  });

  describe("parseFitbitActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseFitbitActivity(sampleActivity);

      expect(result.externalId).toBe("12345678");
      expect(result.activityType).toBe("running");
      expect(result.name).toBe("Run");
      expect(result.startedAt).toEqual(new Date("2026-03-01T08:30:00"));
      expect(result.calories).toBe(450);
      expect(result.distanceKm).toBe(10.5);
      expect(result.steps).toBe(8500);
      expect(result.averageHeartRate).toBe(155);
    });

    it("computes endedAt from startedAt + activeDuration", () => {
      const result = parseFitbitActivity(sampleActivity);
      const expectedEnd = new Date(result.startedAt.getTime() + 3600000);
      expect(result.endedAt).toEqual(expectedEnd);
    });

    it("handles missing optional fields", () => {
      const minimal: FitbitActivity = {
        logId: 99999,
        activityName: "Sport",
        activityTypeId: 99999,
        startTime: "10:00",
        activeDuration: 1800000,
        calories: 200,
        distanceUnit: "",
        logType: "manual",
        startDate: "2026-03-01",
      };

      const result = parseFitbitActivity(minimal);

      expect(result.externalId).toBe("99999");
      expect(result.activityType).toBe("other");
      expect(result.distanceKm).toBeUndefined();
      expect(result.steps).toBeUndefined();
      expect(result.averageHeartRate).toBeUndefined();
      expect(result.heartRateZones).toBeUndefined();
    });

    it("preserves heart rate zones", () => {
      const result = parseFitbitActivity(sampleActivity);
      expect(result.heartRateZones).toHaveLength(4);
      expect(result.heartRateZones?.[2]).toEqual({
        name: "Cardio",
        min: 140,
        max: 170,
        minutes: 35,
      });
    });
  });

  describe("parseFitbitSleep", () => {
    it("maps sleep fields correctly", () => {
      const result = parseFitbitSleep(sampleSleep);

      expect(result.externalId).toBe("87654321");
      expect(result.startedAt).toEqual(new Date("2026-02-28T23:15:00.000"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T07:00:00.000"));
      expect(result.durationMinutes).toBe(465); // 27900000 / 60000
      expect(result.efficiencyPct).toBe(92);
      expect(result.isNap).toBe(false);
    });

    it("maps stage summary minutes", () => {
      const result = parseFitbitSleep(sampleSleep);

      expect(result.deepMinutes).toBe(85);
      expect(result.lightMinutes).toBe(210);
      expect(result.remMinutes).toBe(95);
      expect(result.awakeMinutes).toBe(35);
    });

    it("handles classic sleep type (no stage breakdown)", () => {
      const classicSleep: FitbitSleepLog = {
        ...sampleSleep,
        type: "classic",
        levels: {
          summary: {},
        },
      };

      const result = parseFitbitSleep(classicSleep);

      expect(result.deepMinutes).toBeUndefined();
      expect(result.lightMinutes).toBeUndefined();
      expect(result.remMinutes).toBeUndefined();
      expect(result.awakeMinutes).toBeUndefined();
    });

    it("identifies naps", () => {
      const napSleep: FitbitSleepLog = {
        ...sampleSleep,
        isMainSleep: false,
      };

      const result = parseFitbitSleep(napSleep);
      expect(result.isNap).toBe(true);
    });
  });

  describe("parseFitbitDailySummary", () => {
    it("maps daily summary fields", () => {
      const result = parseFitbitDailySummary("2026-03-01", sampleDailySummary);

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(12345);
      expect(result.restingHr).toBe(58);
      expect(result.activeEnergyKcal).toBe(1200);
      expect(result.exerciseMinutes).toBe(70); // fairlyActive + veryActive
      expect(result.flightsClimbed).toBe(12);
    });

    it("extracts total distance from distances array", () => {
      const result = parseFitbitDailySummary("2026-03-01", sampleDailySummary);
      expect(result.distanceKm).toBe(9.5);
    });

    it("handles missing restingHeartRate", () => {
      const noRhr: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          restingHeartRate: undefined,
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noRhr);
      expect(result.restingHr).toBeUndefined();
    });

    it("handles missing floors", () => {
      const noFloors: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          floors: undefined,
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noFloors);
      expect(result.flightsClimbed).toBeUndefined();
    });

    it("returns undefined distance when no total in distances array", () => {
      const noTotal: FitbitDailySummary = {
        summary: {
          ...sampleDailySummary.summary,
          distances: [{ activity: "tracker", distance: 9.5 }],
        },
      };

      const result = parseFitbitDailySummary("2026-03-01", noTotal);
      expect(result.distanceKm).toBeUndefined();
    });
  });

  describe("parseFitbitWeightLog", () => {
    it("maps weight log fields", () => {
      const result = parseFitbitWeightLog(sampleWeightLog);

      expect(result.externalId).toBe("55555");
      expect(result.weightKg).toBe(82.5);
      expect(result.bodyFatPct).toBe(18.5);
      expect(result.recordedAt).toEqual(new Date("2026-03-01T07:30:00"));
    });

    it("handles missing body fat", () => {
      const noFat: FitbitWeightLog = {
        ...sampleWeightLog,
        fat: undefined,
      };

      const result = parseFitbitWeightLog(noFat);
      expect(result.weightKg).toBe(82.5);
      expect(result.bodyFatPct).toBeUndefined();
    });
  });
});
