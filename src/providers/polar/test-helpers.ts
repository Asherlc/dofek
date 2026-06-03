import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./types.ts";

export const sampleExercise: PolarExercise = {
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

export const sampleSleep: PolarSleep = {
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

export const sampleDailyActivity: PolarDailyActivity = {
  polar_user: "https://www.polar.com/v3/users/12345",
  start_time: "2024-06-15T08:00:00",
  end_time: "2024-06-15T23:59:59",
  active_duration: "PT3H11M",
  inactive_duration: "PT18H23M30S",
  daily_activity: 89.1,
  calories: 2500,
  active_calories: 800,
  duration: "PT14H30M",
  steps: 12345,
};

export const sampleNightlyRecharge: PolarNightlyRecharge = {
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
