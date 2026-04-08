import type { CanonicalActivityType } from "@dofek/training/training";

export interface PolarExercise {
  id: string;
  upload_time: string;
  polar_user: string;
  device: string;
  start_time: string;
  duration: string;
  calories: number;
  distance?: number;
  heart_rate?: { average: number; maximum: number };
  sport: string;
  has_route: boolean;
  detailed_sport_info: string;
}

export interface PolarSleep {
  polar_user: string;
  date: string;
  sleep_start_time: string;
  sleep_end_time: string;
  device_id: string;
  continuity: number;
  continuity_class: number;
  light_sleep: number;
  deep_sleep: number;
  rem_sleep: number;
  unrecognized_sleep_stage: number;
  sleep_score: number;
  total_interruption_duration: number;
  sleep_charge: number;
  sleep_goal_minutes: number;
  sleep_rating: number;
  hypnogram: Record<string, number>;
}

export interface PolarDailyActivity {
  polar_user: string;
  date: string;
  created: string;
  calories: number;
  active_calories: number;
  duration: string;
  active_steps: number;
}

export interface PolarNightlyRecharge {
  polar_user: string;
  date: string;
  heart_rate_avg: number;
  beat_to_beat_avg: number;
  heart_rate_variability_avg: number;
  breathing_rate_avg: number;
  nightly_recharge_status: number;
  ans_charge: number;
  ans_charge_status: number;
}

export interface ParsedPolarActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  distanceMeters?: number;
  calories: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
}

export interface ParsedPolarSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  lightMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
}

export interface ParsedPolarSleepStage {
  stage: "deep" | "light" | "rem" | "awake";
  startedAt: Date;
  endedAt: Date;
}

export interface ParsedPolarDailyMetrics {
  date: string;
  steps: number;
  activeEnergyKcal: number;
  restingHr?: number;
  hrv?: number;
  respiratoryRateAvg?: number;
}
