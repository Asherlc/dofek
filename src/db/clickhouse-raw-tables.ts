import {
  peerDbMetadataColumnDefinitions,
  replacingMergeTreeTable,
} from "./clickhouse-sql-helpers.ts";

export function buildPostgresFitnessRawTableStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS postgres_fitness.activity (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  activity_type String,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  name Nullable(String),
  notes Nullable(String),
  perceived_exertion Nullable(Float32),
  source_name Nullable(String),
  timezone Nullable(String),
  strava_id Nullable(String),
  raw Nullable(String),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, started_at, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.sleep_session (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_minutes Nullable(Int32),
  deep_minutes Nullable(Int32),
  rem_minutes Nullable(Int32),
  light_minutes Nullable(Int32),
  awake_minutes Nullable(Int32),
  efficiency_pct Nullable(Float32),
  sleep_type Nullable(String),
  sleep_need_baseline_minutes Nullable(Int32),
  sleep_need_from_debt_minutes Nullable(Int32),
  sleep_need_from_strain_minutes Nullable(Int32),
  sleep_need_from_nap_minutes Nullable(Int32),
  source_name Nullable(String),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, started_at, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.sleep_stage (
  id UUID,
  session_id UUID,
  stage String,
  started_at DateTime64(6, 'UTC'),
  ended_at DateTime64(6, 'UTC'),
  source_name Nullable(String),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(session_id, started_at, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.daily_metrics (
  id UUID,
  date Date,
  provider_id String,
  user_id UUID,
  hrv Nullable(Float32),
  spo2_avg Nullable(Float32),
  respiratory_rate_avg Nullable(Float32),
  steps Nullable(Int32),
  active_energy_kcal Nullable(Float32),
  basal_energy_kcal Nullable(Float32),
  distance_km Nullable(Float32),
  cycling_distance_km Nullable(Float32),
  flights_climbed Nullable(Int32),
  exercise_minutes Nullable(Int32),
  walking_speed Nullable(Float32),
  walking_step_length Nullable(Float32),
  walking_double_support_pct Nullable(Float32),
  walking_asymmetry_pct Nullable(Float32),
  walking_steadiness Nullable(Float32),
  stand_hours Nullable(Int32),
  skin_temp_c Nullable(Float32),
  stress_high_minutes Nullable(Int32),
  recovery_high_minutes Nullable(Int32),
  resilience_level Nullable(String),
  push_count Nullable(Int32),
  wheelchair_distance_km Nullable(Float32),
  uv_exposure Nullable(Float32),
  source_name Nullable(String),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, date, provider_id, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.body_measurement (
  id UUID,
  recorded_at DateTime64(6, 'UTC'),
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  weight_kg Nullable(Float32),
  body_fat_pct Nullable(Float32),
  muscle_mass_kg Nullable(Float32),
  bone_mass_kg Nullable(Float32),
  water_pct Nullable(Float32),
  bmi Nullable(Float32),
  height_cm Nullable(Float32),
  waist_circumference_cm Nullable(Float32),
  systolic_bp Nullable(Int32),
  diastolic_bp Nullable(Int32),
  heart_pulse Nullable(Int32),
  temperature_c Nullable(Float32),
  source_name Nullable(String),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, recorded_at, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.provider (
  id String,
  name String,
  api_base_url Nullable(String),
  user_id UUID,
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.provider_priority (
  provider_id String,
  priority Int32,
  sleep_priority Nullable(Int32),
  body_priority Nullable(Int32),
  recovery_priority Nullable(Int32),
  daily_activity_priority Nullable(Int32),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(provider_id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.device_priority (
  provider_id String,
  source_name_pattern String,
  priority Nullable(Int32),
  sleep_priority Nullable(Int32),
  body_priority Nullable(Int32),
  recovery_priority Nullable(Int32),
  daily_activity_priority Nullable(Int32),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(provider_id, source_name_pattern)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.user_profile (
  id UUID,
  name String,
  email Nullable(String),
  birth_date Nullable(Date),
  max_hr Nullable(Int16),
  resting_hr Nullable(Int16),
  ftp Nullable(Int16),
  is_admin Bool,
  created_at DateTime64(6, 'UTC'),
  updated_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(id)")}`,
    `CREATE VIEW IF NOT EXISTS postgres_fitness.user_profile_current AS
SELECT
  id,
  name,
  email,
  birth_date,
  max_hr,
  resting_hr,
  ftp,
  is_admin,
  created_at,
  updated_at
FROM postgres_fitness.user_profile FINAL
WHERE _peerdb_is_deleted = 0`,
  ];
}
