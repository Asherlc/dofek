import {
  peerDbMetadataColumnDefinitions,
  replacingMergeTreeTable,
} from "./clickhouse-sql-helpers.ts";

interface PostgresFitnessActivityRawTableOptions {
  tableName?: string;
  ifNotExists?: boolean;
}

interface PostgresFitnessProviderRawTableOptions {
  tableName?: string;
  ifNotExists?: boolean;
}

export function buildPostgresFitnessActivityRawTableStatement(
  options: PostgresFitnessActivityRawTableOptions = {},
): string {
  const tableName = options.tableName ?? "postgres_fitness.activity";
  const createTable = options.ifNotExists === false ? "CREATE TABLE" : "CREATE TABLE IF NOT EXISTS";
  return `${createTable} ${tableName} (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  canonical_type String,
  provider_type String,
  modality Nullable(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  name Nullable(String),
  notes Nullable(String),
  perceived_exertion Nullable(Float32),
  source_name Nullable(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String) DEFAULT 'unknown',
  strava_id Nullable(String),
  raw Nullable(String),
  provider_absent_at Nullable(DateTime64(6, 'UTC')),
  deleted_at Nullable(DateTime64(6, 'UTC')),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("id")}`;
}

export function buildPostgresFitnessProviderRawTableStatement(
  options: PostgresFitnessProviderRawTableOptions = {},
): string {
  const tableName = options.tableName ?? "postgres_fitness.provider";
  const createTable = options.ifNotExists === false ? "CREATE TABLE" : "CREATE TABLE IF NOT EXISTS";
  return `${createTable} ${tableName} (
  id String,
  name String,
  api_base_url Nullable(String),
  user_id Nullable(UUID),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(id)")}`;
}

export function buildPostgresFitnessProviderConnectionRawTableStatement(): string {
  return `CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection (
  user_id UUID,
  provider_id String,
  created_at DateTime64(6, 'UTC'),
  updated_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, provider_id)")}`;
}

export function buildPostgresFitnessRawTableStatements(): string[] {
  return [
    buildPostgresFitnessActivityRawTableStatement(),
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
  staging_available Bool DEFAULT false,
  sleep_type Nullable(String),
  is_nap Bool DEFAULT false,
  sleep_need_baseline_minutes Nullable(Int32),
  sleep_need_from_debt_minutes Nullable(Int32),
  sleep_need_from_strain_minutes Nullable(Int32),
  sleep_need_from_nap_minutes Nullable(Int32),
  source_name Nullable(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String) DEFAULT 'unknown',
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
  distance_km Nullable(Float32),
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
    `CREATE TABLE IF NOT EXISTS postgres_fitness.food_entry (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  date Date,
  meal Nullable(String),
  food_name Nullable(String),
  food_description Nullable(String),
  category Nullable(String),
  provider_food_id Nullable(String),
  provider_serving_id Nullable(String),
  number_of_units Nullable(Float32),
  logged_at Nullable(DateTime64(6, 'UTC')),
  source_name Nullable(String),
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  barcode Nullable(String),
  serving_unit Nullable(String),
  serving_weight_grams Nullable(Float32),
  raw Nullable(String),
  confirmed Bool,
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, date, provider_id, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.health_event (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id Nullable(String),
  type String,
  value Nullable(Float32),
  value_text Nullable(String),
  unit Nullable(String),
  source_name Nullable(String),
  start_date DateTime64(6, 'UTC'),
  end_date Nullable(DateTime64(6, 'UTC')),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, start_date, provider_id, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.clinical_record (
  id UUID,
  user_id UUID,
  provider_id String,
  external_id String,
  clinical_type String,
  display_name String,
  source_name Nullable(String),
  fhir_version String,
  fhir String,
  downloaded_at DateTime64(6, 'UTC'),
  recorded_at Nullable(DateTime64(6, 'UTC')),
  issued_at Nullable(DateTime64(6, 'UTC')),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, downloaded_at, provider_id, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.journal_entry (
  id UUID,
  date Date,
  provider_id String,
  user_id UUID,
  question_slug String,
  answer_text Nullable(String),
  answer_numeric Nullable(Float32),
  impact_score Nullable(Float32),
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, date, provider_id, id)")}`,
    buildPostgresFitnessProviderRawTableStatement(),
    buildPostgresFitnessProviderConnectionRawTableStatement(),
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
    `CREATE TABLE IF NOT EXISTS postgres_fitness.sensor_provider_priority (
  provider_id String,
  channel String,
  priority Int32,
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(provider_id, channel)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.sensor_device_priority (
  provider_id String,
  source_name_pattern String,
  channel String,
  priority Int32,
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(provider_id, source_name_pattern, channel)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker (
  id UUID,
  operation_id UUID,
  dataset_key String,
  flow_name String,
  batch_key String,
  source_watermark String,
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(operation_id, dataset_key, flow_name, batch_key, id)")}`,
    `CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_provider_inventory (
  id UUID,
  operation_id UUID,
  dataset_key String,
  flow_name String,
  batch_key String,
  source_watermark String,
  created_at DateTime64(6, 'UTC'),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(operation_id, dataset_key, flow_name, batch_key, id)")}`,
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
