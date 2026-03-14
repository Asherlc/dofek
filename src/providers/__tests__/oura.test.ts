import { describe, expect, it } from "vitest";
import {
  type OuraDailyActivity,
  type OuraDailyReadiness,
  type OuraSleepDocument,
  parseOuraDailyMetrics,
  parseOuraSleep,
} from "../oura.ts";

// ============================================================
// Sample API responses (Oura API v2 format)
// ============================================================

const sampleSleep: OuraSleepDocument = {
  id: "sleep-abc123",
  day: "2026-03-01",
  bedtime_start: "2026-02-28T22:30:00+00:00",
  bedtime_end: "2026-03-01T06:45:00+00:00",
  total_sleep_duration: 28800, // 480 min = 8h
  deep_sleep_duration: 5400, // 90 min
  rem_sleep_duration: 5700, // 95 min
  light_sleep_duration: 14400, // 240 min
  awake_time: 3300, // 55 min
  efficiency: 87,
  type: "long_sleep",
  average_heart_rate: 52,
  lowest_heart_rate: 45,
  average_hrv: 48,
  time_in_bed: 29700, // seconds
  readiness_score_delta: 2.5,
  latency: 900, // seconds
};

const sampleNap: OuraSleepDocument = {
  id: "sleep-nap456",
  day: "2026-03-01",
  bedtime_start: "2026-03-01T14:00:00+00:00",
  bedtime_end: "2026-03-01T14:30:00+00:00",
  total_sleep_duration: 1500,
  deep_sleep_duration: 0,
  rem_sleep_duration: 300,
  light_sleep_duration: 1200,
  awake_time: 300,
  efficiency: 80,
  type: "rest",
  average_heart_rate: 58,
  lowest_heart_rate: 52,
  average_hrv: 42,
  time_in_bed: 1800,
  readiness_score_delta: null,
  latency: 120,
};

const sampleReadiness: OuraDailyReadiness = {
  id: "readiness-abc123",
  day: "2026-03-01",
  score: 82,
  temperature_deviation: -0.15,
  temperature_trend_deviation: 0.05,
  contributors: {
    resting_heart_rate: 85,
    hrv_balance: 78,
    body_temperature: 90,
    recovery_index: 72,
    sleep_balance: 80,
    previous_night: 88,
    previous_day_activity: 75,
    activity_balance: 82,
  },
};

const sampleActivity: OuraDailyActivity = {
  id: "activity-abc123",
  day: "2026-03-01",
  steps: 9500,
  active_calories: 450,
  equivalent_walking_distance: 8200,
  high_activity_time: 2700, // 45 min in seconds
  medium_activity_time: 1800, // 30 min in seconds
  low_activity_time: 7200, // 120 min in seconds
  resting_time: 50400,
  sedentary_time: 28800,
  total_calories: 2300,
};

// ============================================================
// Tests
// ============================================================

describe("Oura Provider", () => {
  describe("parseOuraSleep", () => {
    it("maps sleep fields correctly", () => {
      const result = parseOuraSleep(sampleSleep);

      expect(result.externalId).toBe("sleep-abc123");
      expect(result.startedAt).toEqual(new Date("2026-02-28T22:30:00+00:00"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T06:45:00+00:00"));
      expect(result.durationMinutes).toBe(480);
      expect(result.deepMinutes).toBe(90);
      expect(result.remMinutes).toBe(95);
      expect(result.lightMinutes).toBe(240);
      expect(result.awakeMinutes).toBe(55);
      expect(result.efficiencyPct).toBe(87);
      expect(result.isNap).toBe(false);
    });

    it("identifies naps from rest type", () => {
      const result = parseOuraSleep(sampleNap);

      expect(result.isNap).toBe(true);
      expect(result.durationMinutes).toBe(25);
      expect(result.lightMinutes).toBe(20);
    });

    it("handles missing optional duration fields", () => {
      const minimal: OuraSleepDocument = {
        ...sampleSleep,
        total_sleep_duration: null,
        deep_sleep_duration: null,
        rem_sleep_duration: null,
        light_sleep_duration: null,
        awake_time: null,
      };

      const result = parseOuraSleep(minimal);

      expect(result.deepMinutes).toBeUndefined();
      expect(result.remMinutes).toBeUndefined();
      expect(result.lightMinutes).toBeUndefined();
      expect(result.awakeMinutes).toBeUndefined();
      expect(result.durationMinutes).toBeUndefined();
    });
  });

  describe("parseOuraDailyMetrics", () => {
    it("maps daily readiness and activity fields", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, sampleActivity);

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBe(78); // from contributors.hrv_balance
      expect(result.restingHr).toBe(85); // from contributors.resting_heart_rate
      expect(result.exerciseMinutes).toBe(75); // (2700 + 1800) / 60
      expect(result.skinTempC).toBe(-0.15);
    });

    it("handles null readiness", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity);

      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
      expect(result.skinTempC).toBeUndefined();
    });

    it("handles null activity", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, null);

      expect(result.steps).toBeUndefined();
      expect(result.activeEnergyKcal).toBeUndefined();
      expect(result.exerciseMinutes).toBeUndefined();
      expect(result.hrv).toBe(78);
      expect(result.restingHr).toBe(85);
    });

    it("handles null contributors in readiness", () => {
      const noContributors: OuraDailyReadiness = {
        ...sampleReadiness,
        contributors: {
          resting_heart_rate: null,
          hrv_balance: null,
          body_temperature: null,
          recovery_index: null,
          sleep_balance: null,
          previous_night: null,
          previous_day_activity: null,
          activity_balance: null,
        },
      };

      const result = parseOuraDailyMetrics(noContributors, sampleActivity);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });
  });
});
