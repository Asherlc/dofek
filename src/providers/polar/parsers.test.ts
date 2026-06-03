import { describe, expect, it } from "vitest";
import {
  mapPolarSport,
  parsePolarDailyActivity,
  parsePolarDuration,
  parsePolarExercise,
  parsePolarSleep,
  parsePolarSleepStages,
} from "./parsers.ts";
import {
  sampleDailyActivity,
  sampleExercise,
  sampleNightlyRecharge,
  sampleSleep,
} from "./test-helpers.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./types.ts";

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

  it("handles fractional hours", () => {
    expect(parsePolarDuration("PT1.5H")).toBe(5400);
  });

  it("handles fractional minutes", () => {
    expect(parsePolarDuration("PT1.5M")).toBe(90);
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

  it("maps pilates", () => {
    expect(mapPolarSport("PILATES")).toBe("pilates");
  });

  it("maps cross_country_skiing", () => {
    expect(mapPolarSport("CROSS_COUNTRY_SKIING")).toBe("cross_country_skiing");
  });

  it("maps rowing", () => {
    expect(mapPolarSport("ROWING")).toBe("rowing");
  });

  it("maps elliptical", () => {
    expect(mapPolarSport("ELLIPTICAL")).toBe("elliptical");
  });

  it("maps mountain_biking", () => {
    expect(mapPolarSport("MOUNTAIN_BIKING")).toBe("mountain_biking");
  });

  it("maps trail_running", () => {
    expect(mapPolarSport("TRAIL_RUNNING")).toBe("trail_running");
  });

  it("maps cross_training", () => {
    expect(mapPolarSport("CROSS_TRAINING")).toBe("cross_training");
  });

  it("maps group_exercise", () => {
    expect(mapPolarSport("GROUP_EXERCISE")).toBe("group_exercise");
  });

  it("maps stretching", () => {
    expect(mapPolarSport("STRETCHING")).toBe("stretching");
  });

  it("maps dance", () => {
    expect(mapPolarSport("DANCE")).toBe("dance");
  });

  it("maps martial_arts", () => {
    expect(mapPolarSport("MARTIAL_ARTS")).toBe("martial_arts");
  });

  it("maps tennis", () => {
    expect(mapPolarSport("TENNIS")).toBe("tennis");
  });

  it("maps basketball", () => {
    expect(mapPolarSport("BASKETBALL")).toBe("basketball");
  });

  it("maps soccer", () => {
    expect(mapPolarSport("SOCCER")).toBe("soccer");
  });

  it("maps golf", () => {
    expect(mapPolarSport("GOLF")).toBe("golf");
  });

  it("maps ice_hockey", () => {
    expect(mapPolarSport("ICE_HOCKEY")).toBe("ice_hockey");
  });

  it("maps skiing", () => {
    expect(mapPolarSport("SKIING")).toBe("skiing");
  });

  it("maps snowboarding", () => {
    expect(mapPolarSport("SNOWBOARDING")).toBe("snowboarding");
  });

  it("maps skating", () => {
    expect(mapPolarSport("SKATING")).toBe("skating");
  });

  it("maps rock_climbing", () => {
    expect(mapPolarSport("ROCK_CLIMBING")).toBe("rock_climbing");
  });

  it("maps surfing", () => {
    expect(mapPolarSport("SURFING")).toBe("surfing");
  });

  it("maps kayaking", () => {
    expect(mapPolarSport("KAYAKING")).toBe("kayaking");
  });

  it("maps functional_training", () => {
    expect(mapPolarSport("FUNCTIONAL_TRAINING")).toBe("functional_fitness");
  });

  it("maps bootcamp", () => {
    expect(mapPolarSport("BOOTCAMP")).toBe("bootcamp");
  });

  it("maps boxing", () => {
    expect(mapPolarSport("BOXING")).toBe("boxing");
  });

  it("maps core", () => {
    expect(mapPolarSport("CORE")).toBe("core");
  });

  it("maps aqua_fitness", () => {
    expect(mapPolarSport("AQUA_FITNESS")).toBe("aqua_fitness");
  });

  it("maps circuit_training", () => {
    expect(mapPolarSport("CIRCUIT_TRAINING")).toBe("circuit_training");
  });

  it("maps triathlon", () => {
    expect(mapPolarSport("TRIATHLON")).toBe("triathlon");
  });

  it("maps indoor_cycling to indoor_cycling", () => {
    expect(mapPolarSport("INDOOR_CYCLING")).toBe("indoor_cycling");
  });

  it("maps indoor_rowing to rowing", () => {
    expect(mapPolarSport("INDOOR_ROWING")).toBe("rowing");
  });

  it("maps indoor_running to running", () => {
    expect(mapPolarSport("INDOOR_RUNNING")).toBe("running");
  });

  it("maps indoor_walking to walking", () => {
    expect(mapPolarSport("INDOOR_WALKING")).toBe("walking");
  });

  it("maps treadmill_running to running", () => {
    expect(mapPolarSport("TREADMILL_RUNNING")).toBe("running");
  });

  it("maps stair_climbing to stairmaster", () => {
    expect(mapPolarSport("STAIR_CLIMBING")).toBe("stairmaster");
  });
});

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

  it("handles exercise with duration-only format", () => {
    const exercise: PolarExercise = {
      id: "ex-456",
      upload_time: "2024-06-15T10:00:00Z",
      polar_user: "https://www.polar.com/v3/users/12345",
      device: "Polar Vantage M2",
      start_time: "2024-06-15T06:00:00Z",
      duration: "PT45M",
      calories: 300,
      sport: "YOGA",
      has_route: false,
      detailed_sport_info: "Yoga",
    };

    const result = parsePolarExercise(exercise);
    expect(result.activityType).toBe("yoga");
    expect(result.durationSeconds).toBe(2700);
    expect(result.distanceMeters).toBeUndefined();
    expect(result.avgHeartRate).toBeUndefined();
    expect(result.maxHeartRate).toBeUndefined();
  });
});

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

  it("does not include efficiencyPct (derived in v_sleep view)", () => {
    const result = parsePolarSleep(sampleSleep);
    expect(result).not.toHaveProperty("efficiencyPct");
  });

  it("handles zero total in-bed time", () => {
    const sleep: PolarSleep = {
      polar_user: "https://www.polar.com/v3/users/12345",
      date: "2024-06-15",
      sleep_start_time: "2024-06-14T22:30:00Z",
      sleep_end_time: "2024-06-14T22:30:00Z", // same start and end
      device_id: "device-abc",
      continuity: 0,
      continuity_class: 0,
      light_sleep: 0,
      deep_sleep: 0,
      rem_sleep: 0,
      unrecognized_sleep_stage: 0,
      sleep_score: 0,
      total_interruption_duration: 0,
      sleep_charge: 1,
      sleep_goal_minutes: 480,
      sleep_rating: 1,
      hypnogram: {},
    };

    const result = parsePolarSleep(sleep);
    expect(result).not.toHaveProperty("efficiencyPct");
    expect(result.durationMinutes).toBe(0);
  });
});

describe("parsePolarSleepStages", () => {
  const sleepStart = "2024-06-14T22:30:00Z";

  it("converts hypnogram entries to stage intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1, // minute 0: deep
      "1": 1, // minute 1: deep
      "2": 2, // minute 2: light
      "3": 2, // minute 3: light
      "4": 3, // minute 4: rem
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(3);
    expect(stages[0]?.stage).toBe("deep");
    expect(stages[1]?.stage).toBe("light");
    expect(stages[2]?.stage).toBe("rem");
  });

  it("merges consecutive identical stages into single intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1,
      "1": 1,
      "2": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("deep");
    expect(stages[0]?.startedAt).toEqual(new Date("2024-06-14T22:30:00Z"));
    // 3 minutes of deep: starts at minute 0, ends at minute 3
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T22:33:00Z"));
  });

  it("maps hypnogram values 4 and 5 to awake", () => {
    const hypnogram: Record<string, number> = {
      "0": 4,
      "1": 5,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    // Both map to "awake" and are consecutive — should merge
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("awake");
  });

  it("computes timestamps relative to sleep start time", () => {
    const hypnogram: Record<string, number> = {
      "60": 1, // 60 minutes after sleep start
      "61": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages[0]?.startedAt).toEqual(new Date("2024-06-14T23:30:00Z"));
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T23:32:00Z"));
  });

  it("returns empty array for empty hypnogram", () => {
    expect(parsePolarSleepStages(sleepStart, {})).toEqual([]);
  });

  it("skips unknown stage values", () => {
    const hypnogram: Record<string, number> = {
      "0": 99,
      "1": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("deep");
  });

  it("handles non-contiguous minutes as separate intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1,
      "1": 1,
      "10": 1, // gap from minute 2 to 10
      "11": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(2);
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T22:32:00Z"));
    expect(stages[1]?.startedAt).toEqual(new Date("2024-06-14T22:40:00Z"));
  });
});

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

  it("includes respiratory rate from recharge", () => {
    const daily: PolarDailyActivity = {
      polar_user: "user",
      start_time: "2024-06-15T08:00:00",
      end_time: "2024-06-15T23:59:59",
      active_duration: "PT3H11M",
      inactive_duration: "PT18H23M30S",
      daily_activity: 89.1,
      calories: 2000,
      active_calories: 500,
      duration: "PT12H",
      steps: 8000,
    };

    const recharge: PolarNightlyRecharge = {
      polar_user: "user",
      date: "2024-06-15",
      heart_rate_avg: 50,
      beat_to_beat_avg: 1000,
      heart_rate_variability_avg: 70,
      breathing_rate_avg: 16.2,
      nightly_recharge_status: 5,
      ans_charge: 8.5,
      ans_charge_status: 5,
    };

    const result = parsePolarDailyActivity(daily, recharge);
    expect(result.respiratoryRateAvg).toBe(16.2);
    expect(result.restingHr).toBe(50);
    expect(result.hrv).toBe(70);
  });
});
