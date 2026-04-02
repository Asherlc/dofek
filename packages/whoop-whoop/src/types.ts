// ============================================================
// WHOOP internal API response types
// ============================================================

export interface WhoopHrValue {
  time: number; // Unix millis
  data: number; // BPM
}

export interface WhoopHrResponse {
  values: WhoopHrValue[];
}

export interface WhoopRecoveryScore {
  user_calibrating: boolean;
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
}

export interface WhoopRecoveryRecord {
  cycle_id?: number;
  sleep_id?: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  // Legacy uses "score_state", BFF v0 uses "state"
  score_state?: string;
  state?: string;
  score?: WhoopRecoveryScore;
  // BFF v0 flat fields (fields at top level instead of nested under `score`)
  activity_id?: string; // UUID — replaces cycle_id in BFF v0
  recovery_score?: number;
  resting_heart_rate?: number;
  hrv_rmssd?: number; // seconds (not milliseconds)
  spo2_percentage?: number;
  spo2?: number; // BFF v0 uses `spo2` instead of `spo2_percentage`
  skin_temp_celsius?: number;
  calibrating?: boolean;
}

export interface WhoopSleepStageSummary {
  total_in_bed_time_milli: number;
  total_awake_time_milli: number;
  total_no_data_time_milli: number;
  total_light_sleep_time_milli: number;
  total_slow_wave_sleep_time_milli: number;
  total_rem_sleep_time_milli: number;
  sleep_cycle_count: number;
  disturbance_count: number;
}

export interface WhoopSleepNeeded {
  baseline_milli: number;
  need_from_sleep_debt_milli: number;
  need_from_recent_strain_milli: number;
  need_from_recent_nap_milli: number;
}

export interface WhoopSleepScore {
  stage_summary: WhoopSleepStageSummary;
  sleep_needed: WhoopSleepNeeded;
  respiratory_rate: number;
  sleep_performance_percentage: number;
  sleep_consistency_percentage: number;
  sleep_efficiency_percentage: number;
}

export interface WhoopSleepRecord {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  // BFF v0 may use `during` (Postgres range) instead of separate start/end
  start?: string;
  end?: string;
  during?: string; // Postgres range format: "['start','end')"
  timezone_offset: string;
  nap: boolean;
  score_state?: string;
  state?: string; // BFF v0 uses "state" instead of "score_state"
  score?: WhoopSleepScore;
  // Raw stage timing from /sleep-service/v1/sleep-events
  stages?: WhoopSleepEvent[];
}

export interface WhoopSleepEvent {
  stage: string; // "deep", "light", "rem", "awake", "no_data"
  during: string; // Postgres range format: "['2026-03-01T00:00:00Z','2026-03-01T00:15:00Z')"
}

export interface WhoopZoneDuration {
  zone_zero_milli?: number;
  zone_one_milli?: number;
  zone_two_milli?: number;
  zone_three_milli?: number;
  zone_four_milli?: number;
  zone_five_milli?: number;
}

export interface WhoopWorkoutScore {
  strain: number;
  average_heart_rate: number;
  max_heart_rate: number;
  kilojoule: number;
  percent_recorded: number;
  distance_meter?: number;
  altitude_gain_meter?: number;
  altitude_change_meter?: number;
  zone_duration: WhoopZoneDuration;
}

export interface WhoopWorkoutRecord {
  // BFF v0 uses `during` (Postgres range) + `activity_id` (UUID)
  // Both optional because legacy API versions may omit them
  activity_id?: string; // UUID
  during?: string; // Postgres range format: "['start','end')"
  timezone_offset: string;
  sport_id: number;
  average_heart_rate?: number;
  max_heart_rate?: number;
  kilojoules?: number;
  percent_recorded?: number;
  score?: number; // strain score
  // Legacy fields from older API versions / test fixtures
  id?: number;
  user_id?: number;
  created_at?: string;
  updated_at?: string;
  start?: string;
  end?: string;
  score_state?: string;
}

// ============================================================
// WHOOP weightlifting-service types
// ============================================================

export interface WhoopWeightliftingSet {
  weight_kg: number;
  number_of_reps: number;
  msk_total_volume_kg: number;
  time_in_seconds: number;
  during: string;
  complete: boolean;
  strap_location?: string | null;
  strap_location_laterality?: string | null;
}

export interface WhoopExerciseDetails {
  exercise_id: string;
  name: string;
  equipment: string;
  exercise_type: string;
  muscle_groups: string[];
  volume_input_format: string; // "REPS_AND_WEIGHT" | "TIME" | "REPS"
}

export interface WhoopWeightliftingExercise {
  sets: WhoopWeightliftingSet[];
  exercise_details: WhoopExerciseDetails;
}

export interface WhoopWeightliftingGroup {
  workout_exercises: WhoopWeightliftingExercise[];
}

export interface WhoopWeightliftingWorkoutResponse {
  activity_id: string;
  user_id?: number;
  during?: string; // Postgres range format
  name?: string; // workout name
  zone_durations: Record<string, number>;
  workout_groups: WhoopWeightliftingGroup[];
  total_effective_volume_kg: number;
  raw_msk_strain_score: number;
  scaled_msk_strain_score: number;
  cardio_strain_score: number;
  cardio_strain_contribution_percent: number;
  msk_strain_contribution_percent: number;
}

// ============================================================
// Cycle — aggregated response from internal API
// ============================================================

/** BFF v0 activity record (v2_activities array) */
export interface WhoopV2Activity {
  id: string; // UUID activity_id
  type: string; // "sleep", "spin", "functional-fitness", etc.
  during: string; // Postgres range
  score_state: string;
  score_type: string; // "CARDIO", "SLEEP", "RECOVERY"
  sport_id?: number;
}

export interface WhoopCycle {
  id?: number;
  user_id?: number;
  cycle?: Record<string, unknown>;
  days?: string[];
  recovery?: WhoopRecoveryRecord;
  sleep?: { id: number };
  sleeps?: unknown[];
  // BFF v0 shape
  workouts?: WhoopWorkoutRecord[];
  v2_activities?: WhoopV2Activity[];
  // Legacy shape
  strain?: {
    workouts: WhoopWorkoutRecord[];
  };
}

// ============================================================
// Auth types
// ============================================================

export interface WhoopAuthToken {
  accessToken: string;
  refreshToken: string;
  userId: number;
}

/** Result of the initial sign-in — either success or 2FA challenge */
export type WhoopSignInResult =
  | { type: "success"; token: WhoopAuthToken }
  | { type: "verification_required"; session: string; method: string };
