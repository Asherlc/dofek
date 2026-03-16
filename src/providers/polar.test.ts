import { describe, expect, it } from "vitest";
import {
  mapPolarSport,
  type PolarDailyActivity,
  type PolarExercise,
  type PolarNightlyRecharge,
  type PolarSleep,
  parsePolarDailyActivity,
  parsePolarDuration,
  parsePolarExercise,
  parsePolarSleep,
} from "./polar.ts";

// ============================================================
// Pure parsing unit tests (no DB, no network)
// ============================================================

describe("parsePolarDuration", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(parsePolarDuration("PT1H23M45S")).toBe(5025);
  });

  it("parses hours only", () => {
    expect(parsePolarDuration("PT2H")).toBe(7200);
  });

  it("parses minutes only", () => {
    expect(parsePolarDuration("PT30M")).toBe(1800);
  });

  it("parses seconds only", () => {
    expect(parsePolarDuration("PT45S")).toBe(45);
  });

  it("parses hours and minutes without seconds", () => {
    expect(parsePolarDuration("PT1H30M")).toBe(5400);
  });

  it("parses hours and seconds without minutes", () => {
    expect(parsePolarDuration("PT1H15S")).toBe(3615);
  });

  it("returns 0 for empty duration", () => {
    expect(parsePolarDuration("PT")).toBe(0);
  });

  it("handles fractional seconds", () => {
    expect(parsePolarDuration("PT1M30.5S")).toBe(90.5);
  });
});

describe("mapPolarSport", () => {
  it("maps RUNNING to running", () => {
    expect(mapPolarSport("RUNNING")).toBe("running");
  });

  it("maps CYCLING to cycling", () => {
    expect(mapPolarSport("CYCLING")).toBe("cycling");
  });

  it("maps SWIMMING to swimming", () => {
    expect(mapPolarSport("SWIMMING")).toBe("swimming");
  });

  it("maps WALKING to walking", () => {
    expect(mapPolarSport("WALKING")).toBe("walking");
  });

  it("maps HIKING to hiking", () => {
    expect(mapPolarSport("HIKING")).toBe("hiking");
  });

  it("maps STRENGTH_TRAINING to strength", () => {
    expect(mapPolarSport("STRENGTH_TRAINING")).toBe("strength");
  });

  it("maps YOGA to yoga", () => {
    expect(mapPolarSport("YOGA")).toBe("yoga");
  });

  it("maps unknown sport to other", () => {
    expect(mapPolarSport("SOME_UNKNOWN_SPORT")).toBe("other");
  });

  it("is case-insensitive (lowercases input)", () => {
    expect(mapPolarSport("Running")).toBe("running");
  });
});

const sampleExercise: PolarExercise = {
  id: "abc-123",
  upload_time: "2024-06-15T10:00:00Z",
  polar_user: "https://www.polar.com/v3/users/12345",
  device: "Polar Vantage V3",
  start_time: "2024-06-15T08:00:00Z",
  duration: "PT1H23M45S",
  calories: 650,
  distance: 12500,
  heart_rate: { average: 145, maximum: 178 },
  sport: "RUNNING",
  has_route: true,
  detailed_sport_info: "RUNNING_TRAIL",
};

describe("parsePolarExercise", () => {
  it("maps exercise fields to activity", () => {
    const result = parsePolarExercise(sampleExercise);
    expect(result.externalId).toBe("abc-123");
    expect(result.activityType).toBe("running");
    expect(result.startedAt).toEqual(new Date("2024-06-15T08:00:00Z"));
    expect(result.durationSeconds).toBe(5025);
    expect(result.distanceMeters).toBe(12500);
    expect(result.calories).toBe(650);
    expect(result.avgHeartRate).toBe(145);
    expect(result.maxHeartRate).toBe(178);
    expect(result.name).toBe("RUNNING_TRAIL");
  });

  it("computes endedAt from startedAt + duration", () => {
    const result = parsePolarExercise(sampleExercise);
    const expectedEnd = new Date(new Date("2024-06-15T08:00:00Z").getTime() + 5025 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("handles exercise without heart rate data", () => {
    const noHr: PolarExercise = {
      ...sampleExercise,
      heart_rate: undefined,
    };
    const result = parsePolarExercise(noHr);
    expect(result.avgHeartRate).toBeUndefined();
    expect(result.maxHeartRate).toBeUndefined();
  });

  it("handles exercise without distance", () => {
    const noDistance: PolarExercise = {
      ...sampleExercise,
      distance: undefined,
    };
    const result = parsePolarExercise(noDistance);
    expect(result.distanceMeters).toBeUndefined();
  });
});

const sampleSleep: PolarSleep = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  sleep_start_time: "2024-06-14T22:30:00Z",
  sleep_end_time: "2024-06-15T06:45:00Z",
  device_id: "device-abc",
  continuity: 3.2,
  continuity_class: 3,
  light_sleep: 10800,
  deep_sleep: 7200,
  rem_sleep: 5400,
  unrecognized_sleep_stage: 600,
  sleep_score: 82,
  total_interruption_duration: 1800,
  sleep_charge: 4,
  sleep_goal_minutes: 480,
  sleep_rating: 4,
  hypnogram: {},
};

describe("parsePolarSleep", () => {
  it("maps sleep fields to sleep session", () => {
    const result = parsePolarSleep(sampleSleep);
    expect(result.externalId).toBe("2024-06-15");
    expect(result.startedAt).toEqual(new Date("2024-06-14T22:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2024-06-15T06:45:00Z"));
    expect(result.lightMinutes).toBe(180); // 10800 / 60
    expect(result.deepMinutes).toBe(120); // 7200 / 60
    expect(result.remMinutes).toBe(90); // 5400 / 60
    expect(result.awakeMinutes).toBe(30); // 1800 / 60
  });

  it("computes total duration in minutes from stages", () => {
    const result = parsePolarSleep(sampleSleep);
    // light + deep + rem = 180 + 120 + 90 = 390 minutes
    expect(result.durationMinutes).toBe(390);
  });

  it("computes efficiency as sleep time / total time in bed", () => {
    const result = parsePolarSleep(sampleSleep);
    // Total sleep = 10800 + 7200 + 5400 = 23400s
    // Total in bed = sleep_end - sleep_start = 8h15m = 29700s
    // Efficiency = 23400 / 29700 * 100 = 78.79%
    expect(result.efficiencyPct).toBeCloseTo(78.79, 0);
  });
});

const sampleDailyActivity: PolarDailyActivity = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  created: "2024-06-15T23:59:00Z",
  calories: 2500,
  active_calories: 800,
  duration: "PT14H30M",
  active_steps: 12345,
};

const sampleNightlyRecharge: PolarNightlyRecharge = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  heart_rate_avg: 52,
  beat_to_beat_avg: 980,
  heart_rate_variability_avg: 65,
  breathing_rate_avg: 14.5,
  nightly_recharge_status: 4,
  ans_charge: 7.5,
  ans_charge_status: 4,
};

describe("parsePolarDailyActivity", () => {
  it("maps daily activity with nightly recharge", () => {
    const result = parsePolarDailyActivity(sampleDailyActivity, sampleNightlyRecharge);
    expect(result.date).toBe("2024-06-15");
    expect(result.steps).toBe(12345);
    expect(result.activeEnergyKcal).toBe(800);
    expect(result.restingHr).toBe(52);
    expect(result.hrv).toBe(65);
    expect(result.respiratoryRateAvg).toBe(14.5);
  });

  it("maps daily activity without nightly recharge", () => {
    const result = parsePolarDailyActivity(sampleDailyActivity, null);
    expect(result.date).toBe("2024-06-15");
    expect(result.steps).toBe(12345);
    expect(result.activeEnergyKcal).toBe(800);
    expect(result.restingHr).toBeUndefined();
    expect(result.hrv).toBeUndefined();
    expect(result.respiratoryRateAvg).toBeUndefined();
  });
});
