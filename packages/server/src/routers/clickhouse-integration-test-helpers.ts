import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildClickHouseBootstrapStatements,
  type ClickHouseClient,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
} from "../../../../src/db/clickhouse.ts";
import { buildActivityVo2MaxEstimateTableSql } from "../../../../src/db/clickhouse-activity-vo2max-estimate.ts";
import {
  buildDedupedSensorBackfillSql,
  buildSensorScalarSampleBackfillSql,
} from "../../../../src/db/clickhouse-deduped-sensor.ts";
import { buildActivitySummaryReadModelStatements } from "../../../../src/db/clickhouse-metric-stream-bootstrap.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";

interface ClickHouseSyncTestContext {
  addCleanup(cleanup: () => Promise<void>): void;
  connectionString: string;
}

export interface ClickHouseMetricStreamSeedRow {
  id?: string;
  activityId?: string | null;
  userId: string;
  recordedAt: string;
  channel: string;
  providerId: string;
  externalId?: string | null;
  deviceId?: string | null;
  sourceType?: string | null;
  scalar?: number | null;
  vector?: readonly number[] | null;
  point?: string;
  metadata?: string;
}

interface IsolatedClickHouseDatabases {
  analytics: string;
  ingest: string;
  postgresFitness: string;
}

interface ClickHouseTestHandle {
  client: ClickHouseClient;
  setupClient: ClickHouseClient;
}

interface RawTableSync {
  columns: string[];
  tableName: string;
}

const handlesByContext = new WeakMap<ClickHouseSyncTestContext, ClickHouseTestHandle>();
const clickHouseTestSetupSemaphoreDirectory = join(
  tmpdir(),
  "dofek-clickhouse-integration-test-slots",
);
const clickHouseTestSetupSlotCount = 2;
const clickHouseTestSetupSlotTimeoutMilliseconds = 55_000;
const clickHouseTestSetupStaleSlotMilliseconds = 300_000;
const rawTableSyncs: RawTableSync[] = [
  {
    tableName: "activity",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "activity_type",
      "started_at",
      "ended_at",
      "name",
      "notes",
      "perceived_exertion",
      "source_name",
      "timezone",
      "strava_id",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "sleep_session",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "started_at",
      "ended_at",
      "duration_minutes",
      "deep_minutes",
      "rem_minutes",
      "light_minutes",
      "awake_minutes",
      "efficiency_pct",
      "sleep_type",
      "sleep_need_baseline_minutes",
      "sleep_need_from_debt_minutes",
      "sleep_need_from_strain_minutes",
      "sleep_need_from_nap_minutes",
      "source_name",
      "created_at",
    ],
  },
  {
    tableName: "sleep_stage",
    columns: ["id", "session_id", "stage", "started_at", "ended_at", "source_name", "created_at"],
  },
  {
    tableName: "daily_metrics",
    columns: [
      "id",
      "date",
      "provider_id",
      "user_id",
      "hrv",
      "spo2_avg",
      "respiratory_rate_avg",
      "steps",
      "active_energy_kcal",
      "basal_energy_kcal",
      "distance_km",
      "flights_climbed",
      "exercise_minutes",
      "walking_speed",
      "walking_step_length",
      "walking_double_support_pct",
      "walking_asymmetry_pct",
      "walking_steadiness",
      "stand_hours",
      "skin_temp_c",
      "stress_high_minutes",
      "recovery_high_minutes",
      "resilience_level",
      "push_count",
      "wheelchair_distance_km",
      "uv_exposure",
      "source_name",
      "created_at",
    ],
  },
  {
    tableName: "food_entry",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "date",
      "meal",
      "food_name",
      "food_description",
      "category",
      "provider_food_id",
      "provider_serving_id",
      "number_of_units",
      "logged_at",
      "source_name",
      "started_at",
      "ended_at",
      "barcode",
      "serving_unit",
      "serving_weight_grams",
      "raw",
      "confirmed",
      "created_at",
    ],
  },
  {
    tableName: "health_event",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "type",
      "value",
      "value_text",
      "unit",
      "source_name",
      "start_date",
      "end_date",
      "created_at",
    ],
  },
  {
    tableName: "lab_panel",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "name",
      "loinc_code",
      "status",
      "source_name",
      "recorded_at",
      "issued_at",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "lab_result",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "panel_id",
      "external_id",
      "test_name",
      "loinc_code",
      "value",
      "value_text",
      "unit",
      "reference_range_low",
      "reference_range_high",
      "reference_range_text",
      "status",
      "source_name",
      "recorded_at",
      "issued_at",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "journal_entry",
    columns: [
      "id",
      "date",
      "provider_id",
      "user_id",
      "question_slug",
      "answer_text",
      "answer_numeric",
      "impact_score",
      "created_at",
    ],
  },
  {
    tableName: "provider",
    columns: ["id", "name", "api_base_url", "user_id", "created_at"],
  },
  {
    tableName: "provider_priority",
    columns: [
      "provider_id",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
  },
  {
    tableName: "device_priority",
    columns: [
      "provider_id",
      "source_name_pattern",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
  },
  {
    tableName: "user_profile",
    columns: [
      "id",
      "name",
      "email",
      "birth_date",
      "max_hr",
      "resting_hr",
      "ftp",
      "is_admin",
      "created_at",
      "updated_at",
    ],
  },
];

export const CLICKHOUSE_TEST_VIEW_REGEX =
  /^CREATE (?:MATERIALIZED )?VIEW IF NOT EXISTS ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)(?:\n[\s\S]*?)?\nAS\n?([\s\S]*)$/;
export const clickHouseMigrationAnalyticsViewNames = [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.provider_stats",
  "analytics.deduped_sensor",
  "analytics.resting_heart_rate_sleep_window",
  "analytics.daily_recovery_inputs",
  "analytics.daily_recovery",
  "analytics.deduped_location",
  "analytics.daily_endurance_load",
  "analytics.activity_summary",
  "analytics.hiking_activity",
  "analytics.daily_activity_load",
  "analytics.weekly_endurance_ramp_rate",
  "analytics.weekly_training_monotony",
  "analytics.daily_strain",
  "analytics.daily_body_measurement",
  "analytics.healthspan_activity_zone_minutes",
  "analytics.weekly_healthspan",
  "analytics.activity_trend_daily",
] as const;
const analyticsBuildOrder = [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.provider_stats",
  "analytics.deduped_activities",
  "analytics.resting_heart_rate_sleep_window",
  "analytics.daily_sleep",
  "analytics.daily_recovery_inputs",
  "analytics.daily_recovery",
  "analytics.deduped_location",
  "analytics.activity_location_sample",
  "analytics.activity_sensor_sample",
  "analytics.activity_stream_points",
  "analytics.activity_heart_rate_zones",
  "analytics.activity_summary",
  "analytics.daily_endurance_load",
  "analytics.hiking_activity",
  "analytics.daily_activity_load",
  "analytics.weekly_endurance_ramp_rate",
  "analytics.weekly_training_monotony",
  "analytics.daily_strain",
  "analytics.daily_body_measurement",
  "analytics.healthspan_activity_zone_minutes",
  "analytics.weekly_healthspan",
  "analytics.activity_trend_daily",
] as const;

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function buildPostgresTableFunction(connectionString: string, tableName: string): string {
  const postgres = parsePostgresConnectionForClickHouse(connectionString);
  return `postgresql(${clickHouseStringLiteral(postgres.hostAndPort)}, ${clickHouseStringLiteral(
    postgres.database,
  )}, ${clickHouseStringLiteral(tableName)}, ${clickHouseStringLiteral(
    postgres.user,
  )}, ${clickHouseStringLiteral(postgres.password)}, 'fitness')`;
}

function buildRawTableInsertStatement(connectionString: string, sync: RawTableSync): string {
  const columnList = sync.columns.join(",\n  ");
  return `INSERT INTO postgres_fitness.${sync.tableName} (
  ${columnList}
)
SELECT
  ${columnList}
FROM ${buildPostgresTableFunction(connectionString, sync.tableName)}`;
}

function rewriteClickHouseDatabaseNames(
  query: string,
  databases: IsolatedClickHouseDatabases,
): string {
  return query
    .replace(/\bpostgres_fitness\b/g, databases.postgresFitness)
    .replace(/\bingest\b/g, databases.ingest)
    .replace(/\banalytics\b/g, databases.analytics);
}

function buildTestAnalyticsTableStatement(viewName: string): string {
  const columnDefinitionsByViewName: Record<string, string> = {
    v_activity: `id UUID,
provider_id String,
user_id UUID,
primary_activity_id UUID,
activity_type String,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
source_name Nullable(String),
name Nullable(String),
notes Nullable(String),
timezone Nullable(String),
raw Nullable(String),
source_providers Array(String),
source_external_ids Array(Map(String, Nullable(String))),
absent_source_external_ids Array(Map(String, Nullable(String))),
member_activity_ids Array(UUID)`,
    v_activity_members: `activity_id UUID,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
member_activity_id UUID`,
    v_sleep: `id UUID,
provider_id String,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
duration_minutes Nullable(Int32),
deep_minutes Nullable(Int32),
rem_minutes Nullable(Int32),
light_minutes Nullable(Int32),
awake_minutes Nullable(Int32),
efficiency_pct Nullable(Float64),
sleep_type Nullable(String),
is_nap Nullable(Bool),
source_name Nullable(String),
source_providers Array(String)`,
    resting_heart_rate_sleep_window: `sleep_id UUID,
user_id UUID,
started_at Nullable(DateTime64(6, 'UTC')),
ended_at Nullable(DateTime64(6, 'UTC')),
duration_seconds Nullable(Int64),
sample_count UInt64,
resting_hr Nullable(Int32),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9)`,
    daily_sleep: `user_id UUID,
date Date,
provider_id String,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
duration_minutes Nullable(Int32),
deep_minutes Nullable(Int32),
rem_minutes Nullable(Int32),
light_minutes Nullable(Int32),
awake_minutes Nullable(Int32),
efficiency_pct Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_recovery_inputs: `user_id UUID,
date Date,
hrv Nullable(Float32),
resting_hr Nullable(Float64),
respiratory_rate Nullable(Float32),
efficiency_pct Nullable(Float64),
hrv_mean_30d Nullable(Float64),
hrv_sd_30d Nullable(Float64),
rhr_mean_30d Nullable(Float64),
rhr_sd_30d Nullable(Float64),
rr_mean_30d Nullable(Float64),
rr_sd_30d Nullable(Float64),
hrv_mean_60d Nullable(Float64),
hrv_sd_60d Nullable(Float64),
rhr_mean_60d Nullable(Float64),
rhr_sd_60d Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_recovery: `user_id UUID,
date Date,
hrv Nullable(Float64),
resting_hr Nullable(Float64),
respiratory_rate Nullable(Float64),
efficiency_pct Nullable(Float64),
hrv_mean_30d Nullable(Float64),
hrv_sd_30d Nullable(Float64),
rhr_mean_30d Nullable(Float64),
rhr_sd_30d Nullable(Float64),
rr_mean_30d Nullable(Float64),
rr_sd_30d Nullable(Float64),
hrv_mean_60d Nullable(Float64),
hrv_sd_60d Nullable(Float64),
rhr_mean_60d Nullable(Float64),
rhr_sd_60d Nullable(Float64),
hrv_score Nullable(Float64),
resting_hr_score Nullable(Float64),
sleep_score Nullable(Float64),
respiratory_rate_score Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_body_measurement: `measurement_id UUID,
user_id UUID,
date Date,
recorded_at DateTime64(6, 'UTC'),
weight_kg Float64,
body_fat_pct Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    v_body_measurement: `id UUID,
provider_id String,
user_id UUID,
external_id String,
recorded_at DateTime64(6, 'UTC'),
created_at DateTime64(9),
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
source_providers Array(String)`,
    v_daily_metrics: `date Date,
user_id UUID,
hrv Nullable(Float32),
spo2_avg Nullable(Float32),
respiratory_rate_avg Nullable(Float32),
skin_temp_c Nullable(Float32),
steps Nullable(Int32),
active_energy_kcal Nullable(Float32),
basal_energy_kcal Nullable(Float32),
distance_km Nullable(Float32),
flights_climbed Nullable(Int32),
exercise_minutes Nullable(Int32),
stand_hours Nullable(Int32),
walking_speed Nullable(Float32),
walking_step_length Nullable(Float32),
walking_double_support_pct Nullable(Float32),
walking_asymmetry_pct Nullable(Float32),
walking_steadiness Nullable(Float32),
source_providers Array(String)`,
    provider_stats: `user_id UUID,
provider_id String,
activities UInt64,
daily_metrics UInt64,
sleep_sessions UInt64,
body_measurements UInt64,
food_entries UInt64,
health_events UInt64,
metric_stream UInt64,
nutrition_daily UInt64,
lab_panels UInt64,
lab_results UInt64,
journal_entries UInt64,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    deduped_sensor: `user_id UUID,
recorded_at DateTime64(6, 'UTC'),
recorded_date Date,
channel String,
scalar Nullable(Float32),
provider_id Nullable(String),
source_metric_stream_id Nullable(UUID),
provider_priority UInt16,
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9)`,
    deduped_location: `activity_id UUID,
user_id UUID,
recorded_at DateTime64(6, 'UTC'),
lat Nullable(Float32),
lng Nullable(Float32)`,
    deduped_activities: `activity_id UUID,
provider_id String,
user_id UUID,
activity_type String,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
source_name Nullable(String),
name Nullable(String),
notes Nullable(String),
timezone Nullable(String),
raw Nullable(String),
source_synced_at DateTime64(9, 'UTC'),
source_providers Array(String),
source_external_ids Array(Map(String, Nullable(String))),
absent_source_external_ids Array(Map(String, Nullable(String))),
member_activity_ids Array(UUID),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9, 'UTC')`,
    activity_sensor_sample: `activity_id UUID,
user_id UUID,
recorded_at DateTime64(6, 'UTC'),
recorded_date Date,
channel String,
scalar Nullable(Float32),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9)`,
    activity_location_sample: `activity_id UUID,
user_id UUID,
recorded_at DateTime64(6, 'UTC'),
recorded_date Date,
source_metric_stream_id UUID,
lat Nullable(Float32),
lng Nullable(Float32),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at Nullable(DateTime64(6, 'UTC'))`,
    activity_stream_points: `user_id UUID,
activity_id UUID,
points Array(Tuple(recorded_at DateTime64(6, 'UTC'), heart_rate Nullable(Float64), power Nullable(Float64), speed Nullable(Float64), cadence Nullable(Float64), altitude Nullable(Float64), lat Nullable(Float64), lng Nullable(Float64))),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9)`,
    activity_heart_rate_zones: `user_id UUID,
activity_id UUID,
zones Array(Tuple(zone UInt8, seconds UInt32)),
refresh_version UInt64,
is_deleted UInt8,
refreshed_at DateTime64(9)`,
    activity_summary: `activity_id UUID,
user_id UUID,
activity_type String,
name Nullable(String),
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
avg_hr Nullable(Float64),
max_hr Nullable(Int16),
min_hr Nullable(Int16),
avg_power Nullable(Float64),
max_power Nullable(Int16),
avg_speed Nullable(Float64),
max_speed Nullable(Float64),
avg_cadence Nullable(Float64),
elevation_gain_legacy Nullable(Float64),
total_distance Nullable(Float64),
centroid_lat Nullable(Float64),
centroid_lng Nullable(Float64),
avg_left_balance Nullable(Float64),
avg_left_torque_eff Nullable(Float64),
avg_right_torque_eff Nullable(Float64),
avg_left_pedal_smooth Nullable(Float64),
avg_right_pedal_smooth Nullable(Float64),
elevation_gain_m Nullable(Float64),
elevation_loss_m Nullable(Float64),
avg_stance_time Nullable(Float64),
avg_vertical_osc Nullable(Float64),
avg_ground_contact_time Nullable(Float64),
avg_stride_length Nullable(Float64),
sample_count UInt64,
hr_sample_count UInt64,
power_sample_count UInt64,
first_sample_at DateTime64(6, 'UTC'),
last_sample_at DateTime64(6, 'UTC'),
best_twenty_minute_power Nullable(Float64),
normalized_power Nullable(Float64),
smoothed_avg_power Nullable(Float64),
climbing_elevation_gain_m Nullable(Float64),
climbing_seconds Nullable(Int32)`,
    hiking_activity: `activity_id UUID,
user_id UUID,
activity_type String,
activity_name Nullable(String),
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
distance_m Float64,
duration_seconds Float64,
average_pace_min_per_km Float64,
elevation_gain_m Float64,
elevation_loss_m Float64,
average_grade_percent Float64,
avg_heart_rate Nullable(Float64),
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_activity_load: `activity_id UUID,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at DateTime64(6, 'UTC'),
daily_load Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_endurance_load: `activity_id UUID,
user_id UUID,
started_at Nullable(DateTime64(6, 'UTC')),
ended_at Nullable(DateTime64(6, 'UTC')),
date Nullable(Date),
training_load Float64,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    weekly_endurance_ramp_rate: `user_id UUID,
week Date,
ctl_start Float64,
ctl_end Float64,
ramp_rate Float64,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    weekly_training_monotony: `user_id UUID,
week Date,
monotony Float64,
strain Float64,
weekly_load Float64,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    daily_strain: `user_id UUID,
date Date,
daily_load Float64,
strain Float64,
acute_load_7d Float64,
chronic_load_28d Float64,
workload_ratio Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    healthspan_activity_zone_minutes: `activity_id UUID,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at DateTime64(6, 'UTC'),
aerobic_minutes Float64,
high_intensity_minutes Float64,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    weekly_healthspan: `user_id UUID,
week_start Date,
avg_sleep_min Nullable(Float64),
bedtime_stddev_min Nullable(Float64),
avg_resting_hr Nullable(Float64),
avg_steps Nullable(Float64),
latest_vo2max Nullable(Float64),
weekly_aerobic_min Float64,
weekly_high_intensity_min Float64,
sessions_per_week Nullable(Float64),
weight_kg Nullable(Float64),
body_fat_pct Nullable(Float64),
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    activity_trend_daily: `user_id UUID,
bucket_date Date,
avg_hr Nullable(Float64),
max_hr Nullable(Int16),
avg_power Nullable(Float64),
max_power Nullable(Int16),
avg_cadence Nullable(Float64),
avg_speed Nullable(Float64),
total_samples UInt64,
hr_samples UInt64,
power_samples UInt64,
cadence_samples UInt64,
speed_samples UInt64,
activity_count UInt64`,
    activity_power_curve: `activity_id UUID,
user_id UUID,
started_at Nullable(DateTime64(6, 'UTC')),
activity_date Nullable(String),
duration_seconds Int32,
best_power Nullable(Int32),
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    activity_aerobic_efficiency: `activity_id UUID,
user_id UUID,
activity_type String,
name Nullable(String),
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
max_hr Nullable(Int16),
resting_hr Nullable(Float64),
avg_power_z2 Float64,
avg_hr_z2 Float64,
efficiency_factor Float64,
z2_samples Int32,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
    activity_polarization_zones: `activity_id UUID,
user_id UUID,
activity_type String,
started_at DateTime64(6, 'UTC'),
max_hr Nullable(Int16),
z1_seconds Int32,
z2_seconds Int32,
z3_seconds Int32,
is_deleted UInt8,
refresh_version UInt64,
refreshed_at DateTime64(9)`,
  };
  const shortViewName = viewName.split(".").at(-1);
  if (!shortViewName) {
    throw new Error(`Missing ClickHouse test analytics table name for ${viewName}`);
  }
  const columnDefinitions = columnDefinitionsByViewName[shortViewName];
  if (!columnDefinitions) {
    throw new Error(`Missing ClickHouse test analytics table schema for ${viewName}`);
  }
  const engine =
    shortViewName === "deduped_activities" ||
    shortViewName === "activity_sensor_sample" ||
    shortViewName === "activity_location_sample" ||
    shortViewName === "activity_stream_points" ||
    shortViewName === "activity_heart_rate_zones" ||
    shortViewName === "daily_sleep" ||
    shortViewName === "daily_recovery_inputs" ||
    shortViewName === "daily_recovery" ||
    shortViewName === "daily_body_measurement" ||
    shortViewName === "daily_endurance_load" ||
    shortViewName === "daily_activity_load" ||
    shortViewName === "weekly_endurance_ramp_rate" ||
    shortViewName === "weekly_training_monotony" ||
    shortViewName === "daily_strain" ||
    shortViewName === "healthspan_activity_zone_minutes" ||
    shortViewName === "weekly_healthspan" ||
    shortViewName === "provider_stats" ||
    shortViewName === "hiking_activity" ||
    shortViewName === "activity_power_curve" ||
    shortViewName === "activity_aerobic_efficiency" ||
    shortViewName === "activity_polarization_zones"
      ? "ReplacingMergeTree(refresh_version)"
      : "MergeTree";
  const orderBy =
    shortViewName === "deduped_activities"
      ? "(user_id, activity_id)"
      : shortViewName === "activity_sensor_sample"
        ? "(user_id, activity_id, recorded_date, channel, recorded_at)"
        : shortViewName === "activity_location_sample"
          ? "(user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)"
          : shortViewName === "activity_stream_points" ||
              shortViewName === "activity_heart_rate_zones"
            ? "(user_id, activity_id)"
            : shortViewName === "daily_sleep" || shortViewName === "daily_recovery_inputs"
              ? "(user_id, date)"
              : shortViewName === "daily_recovery"
                ? "(user_id, date)"
                : shortViewName === "daily_body_measurement"
                  ? "(user_id, recorded_at, measurement_id)"
                  : shortViewName === "daily_endurance_load" ||
                      shortViewName === "daily_activity_load" ||
                      shortViewName === "healthspan_activity_zone_minutes"
                    ? "(user_id, activity_id)"
                    : shortViewName === "weekly_endurance_ramp_rate" ||
                        shortViewName === "weekly_training_monotony"
                      ? "(user_id, week)"
                      : shortViewName === "daily_strain"
                        ? "(user_id, date)"
                        : shortViewName === "weekly_healthspan"
                          ? "(user_id, week_start)"
                          : shortViewName === "provider_stats"
                            ? "(user_id, provider_id)"
                            : shortViewName === "activity_power_curve"
                              ? "(user_id, activity_id, duration_seconds)"
                              : shortViewName === "hiking_activity" ||
                                  shortViewName === "activity_aerobic_efficiency" ||
                                  shortViewName === "activity_polarization_zones"
                                ? "(user_id, activity_id)"
                                : "tuple()";
  return `CREATE TABLE IF NOT EXISTS ${viewName} (
${columnDefinitions}
)
ENGINE = ${engine}
ORDER BY ${orderBy}`;
}

function buildTestDedupedActivitiesSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `SELECT
  id AS activity_id,
  provider_id,
  user_id,
  activity_type,
  started_at,
  ended_at,
  source_name,
  name,
  notes,
  timezone,
  raw,
  now64(9, 'UTC') AS source_synced_at,
  source_providers,
  source_external_ids,
  absent_source_external_ids,
  member_activity_ids,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  toUInt8(0) AS is_deleted,
  now64(9, 'UTC') AS refreshed_at
FROM ${databases.analytics}.v_activity`;
}

function buildTestActivitySensorSampleSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH current_activity AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    ended_at
  FROM ${databases.analytics}.deduped_activities FINAL
  WHERE is_deleted = 0
)
SELECT
  current_activity.activity_id AS activity_id,
  samples.user_id AS user_id,
  samples.recorded_at AS recorded_at,
  samples.recorded_date AS recorded_date,
  samples.channel AS channel,
  samples.scalar AS scalar,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  samples.is_deleted AS is_deleted,
  now64(9) AS refreshed_at
FROM ${databases.analytics}.deduped_sensor AS samples
INNER JOIN current_activity
  ON current_activity.user_id = samples.user_id
 AND samples.recorded_at >= current_activity.started_at
 AND samples.recorded_at <= coalesce(current_activity.ended_at, current_activity.started_at + INTERVAL 12 HOUR)`;
}

function buildTestActivityLocationSampleSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `SELECT
  activity_id,
  user_id,
  recorded_at,
  toDate(recorded_at) AS recorded_date,
  generateUUIDv4() AS source_metric_stream_id,
  lat,
  lng,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  toUInt8(0) AS is_deleted,
  now64(6, 'UTC') AS refreshed_at
FROM ${databases.analytics}.deduped_location`;
}

function buildTestProviderStatsSelectSql(selectSql: string): string {
  return selectSql;
}

function buildTestRestingHeartRateSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH
active_sleep AS (
  SELECT
    id AS sleep_id,
    user_id,
    started_at,
    assumeNotNull(ended_at) AS ended_at,
    dateDiff('second', started_at, assumeNotNull(ended_at)) AS duration_seconds,
    multiIf(
      sleep_type IN ('nap', 'late_nap', 'rest'), true,
      sleep_type IN ('sleep', 'long_sleep', 'main'), false,
      sleep_type = 'not_main', coalesce(duration_minutes < 120, true),
      duration_minutes IS NOT NULL, duration_minutes < 120,
      false
    ) AS is_nap
  FROM ${databases.postgresFitness}.sleep_session FINAL
  WHERE _peerdb_is_deleted = 0
    AND ended_at IS NOT NULL
),
active_activity AS (
  SELECT
    id,
    user_id,
    started_at,
    coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
  FROM ${databases.postgresFitness}.activity FINAL
  WHERE _peerdb_is_deleted = 0
),
activity_windows AS (
  SELECT
    user_id,
    groupArray(tuple(started_at, ended_at)) AS windows
  FROM active_activity
  GROUP BY user_id
),
heart_rate_samples AS (
  SELECT
    active_sleep.sleep_id AS sleep_id,
    active_sleep.user_id AS user_id,
    active_sleep.started_at AS started_at,
    active_sleep.ended_at AS ended_at,
    active_sleep.duration_seconds AS duration_seconds,
    samples.scalar AS heart_rate
  FROM active_sleep
  INNER JOIN ${databases.analytics}.deduped_sensor AS samples
    ON samples.user_id = active_sleep.user_id
  LEFT JOIN activity_windows
    ON activity_windows.user_id = samples.user_id
  WHERE active_sleep.is_nap = false
    AND samples.recorded_at >= active_sleep.started_at
    AND samples.recorded_at <= active_sleep.ended_at
    AND samples.channel = 'heart_rate'
    AND samples.is_deleted = 0
    AND samples.scalar IS NOT NULL
    AND NOT arrayExists(
      activity_window -> samples.recorded_at >= tupleElement(activity_window, 1)
        AND samples.recorded_at <= tupleElement(activity_window, 2),
      activity_windows.windows
    )
),
computed_windows AS (
  SELECT
    sleep_id,
    user_id,
    any(started_at) AS started_at,
    any(ended_at) AS ended_at,
    any(duration_seconds) AS duration_seconds,
    count() AS sample_count,
    if(
      sample_count >= 30,
      toInt32(round(arrayAvg(arraySlice(
        arraySort(groupArray(toFloat64(heart_rate))),
        1,
        greatest(toInt32(ceil(sample_count * 0.10)), 1)
      )))),
      CAST(NULL, 'Nullable(Int32)')
    ) AS resting_hr
  FROM heart_rate_samples
  GROUP BY sleep_id, user_id
)
SELECT
  active_sleep.sleep_id AS sleep_id,
  active_sleep.user_id AS user_id,
  CAST(computed_windows.started_at, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
  CAST(computed_windows.ended_at, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
  CAST(computed_windows.duration_seconds, 'Nullable(Int64)') AS duration_seconds,
  coalesce(computed_windows.sample_count, 0) AS sample_count,
  CAST(computed_windows.resting_hr, 'Nullable(Int32)') AS resting_hr,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  if(computed_windows.resting_hr IS NULL, 1, 0) AS is_deleted,
  now64(9, 'UTC') AS refreshed_at
FROM active_sleep
LEFT JOIN computed_windows
  ON computed_windows.user_id = active_sleep.user_id
 AND computed_windows.sleep_id = active_sleep.sleep_id
WHERE active_sleep.is_nap = false`;
}

function buildTestActivitySummarySelectSql(databases: IsolatedClickHouseDatabases): string {
  const statement = rewriteClickHouseDatabaseNames(
    buildActivitySummaryReadModelStatements()[0] ?? "",
    databases,
  );
  const viewMatch = statement.match(
    /^CREATE VIEW IF NOT EXISTS [A-Za-z0-9_]+\.[A-Za-z0-9_]+\nAS\n?([\s\S]*)$/,
  );
  const selectSql = viewMatch?.[1]?.trim();
  if (!selectSql) {
    throw new Error("Could not parse ClickHouse activity summary test SELECT");
  }
  return selectSql;
}

function buildTestActivityStreamPointsSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH latest_sensor_samples AS (
  SELECT *
  FROM (
    SELECT *
    FROM ${databases.analytics}.activity_sensor_sample
    ORDER BY
      user_id ASC,
      activity_id ASC,
      channel ASC,
      recorded_at ASC,
      refresh_version DESC
    LIMIT 1 BY user_id, activity_id, channel, recorded_at
  )
  WHERE is_deleted = 0
),
latest_location_samples AS (
  SELECT *
  FROM (
    SELECT *
    FROM ${databases.analytics}.activity_location_sample
    ORDER BY source_metric_stream_id ASC, refresh_version DESC
    LIMIT 1 BY source_metric_stream_id
  )
  WHERE is_deleted = 0
),
scalar_points AS (
  SELECT
    user_id,
    activity_id,
    recorded_at,
    CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS heart_rate,
    CAST(maxIf(scalar, channel = 'power'), 'Nullable(Float64)') AS power,
    CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS speed,
    CAST(maxIf(scalar, channel = 'cadence'), 'Nullable(Float64)') AS cadence,
    CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS altitude
  FROM latest_sensor_samples
  WHERE scalar IS NOT NULL
    AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
  GROUP BY user_id, activity_id, recorded_at
),
location_points AS (
  SELECT
    location_samples.user_id AS user_id,
    location_samples.activity_id AS activity_id,
    location_samples.recorded_at AS recorded_at,
    CAST(
      argMax(
        location_samples.lat,
        tuple(location_samples.refresh_version, location_samples.source_metric_stream_id)
      ),
      'Nullable(Float64)'
    ) AS lat,
    CAST(
      argMax(
        location_samples.lng,
        tuple(location_samples.refresh_version, location_samples.source_metric_stream_id)
      ),
      'Nullable(Float64)'
    ) AS lng
  FROM latest_location_samples AS location_samples
  WHERE location_samples.lat IS NOT NULL
    AND location_samples.lng IS NOT NULL
  GROUP BY location_samples.user_id, location_samples.activity_id, location_samples.recorded_at
),
combined_sample_times AS (
  SELECT user_id, activity_id, recorded_at FROM scalar_points
  UNION DISTINCT
  SELECT user_id, activity_id, recorded_at FROM location_points
),
point_rows AS (
  SELECT
    combined_sample_times.user_id AS user_id,
    combined_sample_times.activity_id AS activity_id,
    combined_sample_times.recorded_at AS recorded_at,
    scalar_points.heart_rate AS heart_rate,
    scalar_points.power AS power,
    scalar_points.speed AS speed,
    scalar_points.cadence AS cadence,
    scalar_points.altitude AS altitude,
    location_points.lat AS lat,
    location_points.lng AS lng
  FROM combined_sample_times
  LEFT JOIN scalar_points
    ON scalar_points.user_id = combined_sample_times.user_id
   AND scalar_points.activity_id = combined_sample_times.activity_id
   AND scalar_points.recorded_at = combined_sample_times.recorded_at
  LEFT JOIN location_points
    ON location_points.user_id = combined_sample_times.user_id
   AND location_points.activity_id = combined_sample_times.activity_id
   AND location_points.recorded_at = combined_sample_times.recorded_at
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  point_rows.user_id AS user_id,
  point_rows.activity_id AS activity_id,
  arraySort(
    point -> point.1,
    groupArray(tuple(
      point_rows.recorded_at,
      point_rows.heart_rate,
      point_rows.power,
      point_rows.speed,
      point_rows.cadence,
      point_rows.altitude,
      point_rows.lat,
      point_rows.lng
    ))
  ) AS points,
  refresh_clock.refresh_version AS refresh_version,
  toUInt8(0) AS is_deleted,
  refresh_clock.refreshed_at AS refreshed_at
FROM point_rows
CROSS JOIN refresh_clock
GROUP BY
  point_rows.user_id,
  point_rows.activity_id,
  refresh_clock.refresh_version,
  refresh_clock.refreshed_at`;
}

function buildTestHikingActivitySelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_summary AS (
  SELECT
    activity_id,
    user_id,
    activity_type,
    name,
    started_at,
    ended_at,
    coalesce(total_distance, 0) AS distance_m,
    coalesce(elevation_gain_m, 0) AS elevation_gain_m,
    coalesce(elevation_loss_m, 0) AS elevation_loss_m,
    avg_hr
  FROM ${databases.analytics}.activity_summary
  WHERE activity_type IN ('walking', 'hiking', 'trail_running')
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  activity_summary.activity_id AS activity_id,
  activity_summary.user_id AS user_id,
  activity_summary.activity_type AS activity_type,
  activity_summary.name AS activity_name,
  activity_summary.started_at AS started_at,
  activity_summary.ended_at AS ended_at,
  round(activity_summary.distance_m, 1) AS distance_m,
  if(
    activity_summary.ended_at IS NOT NULL,
    toFloat64(dateDiff('second', activity_summary.started_at, activity_summary.ended_at)),
    0
  ) AS duration_seconds,
  if(
    activity_summary.distance_m > 0 AND activity_summary.ended_at IS NOT NULL,
    round(
      (
        dateDiff('second', activity_summary.started_at, activity_summary.ended_at) / 60.0
      ) / (activity_summary.distance_m / 1000.0),
      2
    ),
    0
  ) AS average_pace_min_per_km,
  round(activity_summary.elevation_gain_m, 1) AS elevation_gain_m,
  round(activity_summary.elevation_loss_m, 1) AS elevation_loss_m,
  if(
    activity_summary.distance_m > 0,
    round(
      (
        activity_summary.elevation_gain_m - activity_summary.elevation_loss_m
      ) / activity_summary.distance_m * 100,
      4
    ),
    0
  ) AS average_grade_percent,
  round(activity_summary.avg_hr, 1) AS avg_heart_rate,
  toUInt8(0) AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM activity_summary
CROSS JOIN refresh_clock`;
}

function buildTestActivityHeartRateZonesSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_bounds AS (
  SELECT
    activity.activity_id AS activity_id,
    activity.user_id AS user_id,
    activity.started_at AS started_at
  FROM ${databases.analytics}.deduped_activities AS activity FINAL
  WHERE activity.is_deleted = 0
),
resting_candidates AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    activity_bounds.user_id AS user_id,
    resting.resting_hr AS resting_hr,
    row_number() OVER (
      PARTITION BY activity_bounds.user_id, activity_bounds.activity_id
      ORDER BY resting.ended_at DESC
    ) AS recency_rank
  FROM activity_bounds
  INNER JOIN ${databases.analytics}.resting_heart_rate_sleep_window AS resting FINAL
    ON resting.user_id = activity_bounds.user_id
   AND resting.ended_at <= activity_bounds.started_at
  WHERE resting.is_deleted = 0
    AND resting.ended_at IS NOT NULL
    AND resting.resting_hr IS NOT NULL
    AND resting.resting_hr > 0
),
recent_resting_values AS (
  SELECT
    activity_id,
    user_id,
    arraySort(groupArray(toFloat64(resting_hr))) AS resting_values
  FROM resting_candidates
  WHERE recency_rank <= 14
  GROUP BY activity_id, user_id
),
resting_by_activity AS (
  SELECT
    activity_id,
    user_id,
    if(
      length(resting_values) = 0,
      CAST(NULL, 'Nullable(Float64)'),
      if(
        modulo(length(resting_values), 2) = 1,
        CAST(resting_values[intDiv(length(resting_values), 2) + 1], 'Nullable(Float64)'),
        CAST(
          (
            resting_values[intDiv(length(resting_values), 2)]
            + resting_values[intDiv(length(resting_values), 2) + 1]
          ) / 2,
          'Nullable(Float64)'
        )
      )
    ) AS resting_hr
  FROM recent_resting_values
),
activity_metadata AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    activity_bounds.user_id AS user_id,
    user_profile.max_hr AS max_hr,
    CASE
      WHEN resting_by_activity.resting_hr > 0
       AND resting_by_activity.resting_hr < user_profile.max_hr
        THEN resting_by_activity.resting_hr
      WHEN user_profile.resting_hr > 0
       AND user_profile.resting_hr < user_profile.max_hr
        THEN user_profile.resting_hr
      ELSE least(60, user_profile.max_hr - 1)
    END AS resting_hr
  FROM activity_bounds
  INNER JOIN ${databases.postgresFitness}.user_profile_current AS user_profile
    ON user_profile.id = activity_bounds.user_id
  LEFT JOIN resting_by_activity
    ON resting_by_activity.activity_id = activity_bounds.activity_id
   AND resting_by_activity.user_id = activity_bounds.user_id
  WHERE user_profile.max_hr > 1
),
latest_sensor_samples AS (
  SELECT *
  FROM (
    SELECT *
    FROM ${databases.analytics}.activity_sensor_sample
    ORDER BY
      user_id ASC,
      activity_id ASC,
      channel ASC,
      recorded_at ASC,
      refresh_version DESC
    LIMIT 1 BY user_id, activity_id, channel, recorded_at
  )
  WHERE is_deleted = 0
),
heart_rate_samples AS (
  SELECT
    activity_id,
    user_id,
    scalar AS heart_rate
  FROM latest_sensor_samples
  WHERE channel = 'heart_rate'
    AND scalar IS NOT NULL
),
zone_seconds AS (
  SELECT
    activity_metadata.user_id AS user_id,
    activity_metadata.activity_id AS activity_id,
    zone_numbers.zone AS zone,
    countIf(
      CASE
        WHEN zone_numbers.zone = 0
          THEN heart_rate_samples.heart_rate
            < activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.5
        WHEN zone_numbers.zone = 1
          THEN heart_rate_samples.heart_rate
            >= activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.5
            AND heart_rate_samples.heart_rate
            < activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.6
        WHEN zone_numbers.zone = 2
          THEN heart_rate_samples.heart_rate
            >= activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.6
            AND heart_rate_samples.heart_rate
            < activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.7
        WHEN zone_numbers.zone = 3
          THEN heart_rate_samples.heart_rate
            >= activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.7
            AND heart_rate_samples.heart_rate
            < activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
        WHEN zone_numbers.zone = 4
          THEN heart_rate_samples.heart_rate
            >= activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
            AND heart_rate_samples.heart_rate
            < activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.9
        WHEN zone_numbers.zone = 5
          THEN heart_rate_samples.heart_rate
            >= activity_metadata.resting_hr
            + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.9
        ELSE false
      END
    ) AS seconds
  FROM activity_metadata
  CROSS JOIN (
    SELECT number AS zone
    FROM numbers(6)
  ) AS zone_numbers
  LEFT JOIN heart_rate_samples
    ON heart_rate_samples.activity_id = activity_metadata.activity_id
   AND heart_rate_samples.user_id = activity_metadata.user_id
  GROUP BY activity_metadata.user_id, activity_metadata.activity_id, zone_numbers.zone
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  zone_seconds.user_id AS user_id,
  zone_seconds.activity_id AS activity_id,
  arraySort(
    zone -> zone.1,
    groupArray(tuple(toUInt8(zone_seconds.zone), toUInt32(zone_seconds.seconds)))
  ) AS zones,
  refresh_clock.refresh_version AS refresh_version,
  toUInt8(0) AS is_deleted,
  refresh_clock.refreshed_at AS refreshed_at
FROM zone_seconds
CROSS JOIN refresh_clock
GROUP BY
  zone_seconds.user_id,
  zone_seconds.activity_id,
  refresh_clock.refresh_version,
  refresh_clock.refreshed_at`;
}

function buildTestDailyRecoveryInputsSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH daily_metrics AS (
  SELECT
    user_id,
    date,
    hrv,
    respiratory_rate_avg AS respiratory_rate
  FROM ${databases.analytics}.v_daily_metrics
),
resting_by_date AS (
  SELECT
    user_id,
    toDate(ended_at - INTERVAL 6 HOUR) AS date,
    argMax(resting_hr, tuple(duration_seconds, ended_at)) AS selected_resting_hr
  FROM ${databases.analytics}.resting_heart_rate_sleep_window FINAL
  WHERE is_deleted = 0
    AND ended_at IS NOT NULL
    AND resting_hr IS NOT NULL
  GROUP BY user_id, date
),
sleep_by_date AS (
  SELECT
    user_id,
    toDate(started_at - INTERVAL 6 HOUR) AS date,
    argMax(efficiency_pct, tuple(duration_minutes, started_at)) AS efficiency_pct
  FROM ${databases.analytics}.v_sleep
  WHERE is_nap = false
  GROUP BY user_id, date
),
input_dates AS (
  SELECT user_id, date FROM daily_metrics
  UNION DISTINCT
  SELECT user_id, date FROM resting_by_date
  UNION DISTINCT
  SELECT user_id, date FROM sleep_by_date
),
daily_inputs AS (
  SELECT
    input_dates.user_id AS user_id,
    input_dates.date AS date,
    daily_metrics.hrv AS hrv,
    resting_by_date.selected_resting_hr AS resting_hr,
    daily_metrics.respiratory_rate AS respiratory_rate,
    sleep_by_date.efficiency_pct AS efficiency_pct
  FROM input_dates
  LEFT JOIN daily_metrics
    ON daily_metrics.user_id = input_dates.user_id
   AND daily_metrics.date = input_dates.date
  LEFT JOIN resting_by_date
    ON resting_by_date.user_id = input_dates.user_id
   AND resting_by_date.date = input_dates.date
  LEFT JOIN sleep_by_date
    ON sleep_by_date.user_id = input_dates.user_id
   AND sleep_by_date.date = input_dates.date
),
inputs_with_baselines AS (
  SELECT
    user_id,
    date,
    hrv,
    resting_hr,
    respiratory_rate,
    efficiency_pct,
    avg(hrv) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS hrv_mean_30d,
    stddevPop(hrv) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS hrv_sd_30d,
    avg(resting_hr) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rhr_mean_30d,
    stddevPop(resting_hr) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rhr_sd_30d,
    avg(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rr_mean_30d,
    stddevPop(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rr_sd_30d,
    avg(hrv) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS hrv_mean_60d,
    stddevPop(hrv) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS hrv_sd_60d,
    avg(resting_hr) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS rhr_mean_60d,
    stddevPop(resting_hr) OVER (
      PARTITION BY user_id ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) AS rhr_sd_60d
  FROM daily_inputs
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  CAST(inputs_with_baselines.user_id, 'UUID') AS user_id,
  CAST(inputs_with_baselines.date, 'Date') AS date,
  inputs_with_baselines.hrv AS hrv,
  inputs_with_baselines.resting_hr AS resting_hr,
  inputs_with_baselines.respiratory_rate AS respiratory_rate,
  inputs_with_baselines.efficiency_pct AS efficiency_pct,
  inputs_with_baselines.hrv_mean_30d AS hrv_mean_30d,
  inputs_with_baselines.hrv_sd_30d AS hrv_sd_30d,
  inputs_with_baselines.rhr_mean_30d AS rhr_mean_30d,
  inputs_with_baselines.rhr_sd_30d AS rhr_sd_30d,
  inputs_with_baselines.rr_mean_30d AS rr_mean_30d,
  inputs_with_baselines.rr_sd_30d AS rr_sd_30d,
  inputs_with_baselines.hrv_mean_60d AS hrv_mean_60d,
  inputs_with_baselines.hrv_sd_60d AS hrv_sd_60d,
  inputs_with_baselines.rhr_mean_60d AS rhr_mean_60d,
  inputs_with_baselines.rhr_sd_60d AS rhr_sd_60d,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM inputs_with_baselines
CROSS JOIN refresh_clock`;
}

function buildTestDailySleepSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH ranked_sleep AS (
  SELECT
    user_id,
    toDate(started_at - INTERVAL 6 HOUR) AS date,
    provider_id,
    started_at,
    ended_at,
    duration_minutes,
    deep_minutes,
    rem_minutes,
    light_minutes,
    awake_minutes,
    efficiency_pct,
    row_number() OVER (
      PARTITION BY user_id, toDate(started_at - INTERVAL 6 HOUR)
      ORDER BY duration_minutes DESC NULLS LAST, started_at DESC
    ) AS row_number
  FROM ${databases.analytics}.v_sleep
  WHERE is_nap = false
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  CAST(ranked_sleep.user_id, 'UUID') AS user_id,
  CAST(ranked_sleep.date, 'Date') AS date,
  ranked_sleep.provider_id AS provider_id,
  ranked_sleep.started_at AS started_at,
  ranked_sleep.ended_at AS ended_at,
  ranked_sleep.duration_minutes AS duration_minutes,
  ranked_sleep.deep_minutes AS deep_minutes,
  ranked_sleep.rem_minutes AS rem_minutes,
  ranked_sleep.light_minutes AS light_minutes,
  ranked_sleep.awake_minutes AS awake_minutes,
  ranked_sleep.efficiency_pct AS efficiency_pct,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM ranked_sleep
CROSS JOIN refresh_clock
WHERE ranked_sleep.row_number = 1`;
}

function buildTestDailyActivityLoadSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_load AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    assumeNotNull(ended_at) AS ended_at,
    dateDiff('second', started_at, assumeNotNull(ended_at)) / 60.0
      * avg_hr / nullIf(toFloat64(max_hr), 0) AS daily_load
  FROM ${databases.analytics}.activity_summary
  WHERE ended_at IS NOT NULL
    AND avg_hr IS NOT NULL
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  activity_load.activity_id AS activity_id,
  activity_load.user_id AS user_id,
  activity_load.started_at AS started_at,
  activity_load.ended_at AS ended_at,
  activity_load.daily_load AS daily_load,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM activity_load
CROSS JOIN refresh_clock`;
}

function buildTestDailyEnduranceLoadSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_bounds AS (
  SELECT
    activity_id,
    user_id,
    activity_type,
    started_at,
    assumeNotNull(ended_at) AS ended_at,
    assumeNotNull(avg_hr) AS avg_hr
  FROM ${databases.analytics}.activity_summary
  WHERE ended_at IS NOT NULL
    AND avg_hr IS NOT NULL
    AND avg_hr > 0
),
resting_by_activity AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    activity_bounds.user_id AS user_id,
    argMax(resting.resting_hr, resting.ended_at) AS resting_hr
  FROM activity_bounds
  INNER JOIN ${databases.analytics}.resting_heart_rate_sleep_window AS resting FINAL
    ON resting.user_id = activity_bounds.user_id
   AND toDate(resting.ended_at) <= toDate(activity_bounds.started_at)
  WHERE resting.is_deleted = 0
    AND resting.ended_at IS NOT NULL
    AND resting.resting_hr IS NOT NULL
  GROUP BY
    activity_bounds.activity_id,
    activity_bounds.user_id
),
activity_load AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    activity_bounds.user_id AS user_id,
    activity_bounds.started_at AS started_at,
    activity_bounds.ended_at AS ended_at,
    toDate(activity_bounds.started_at) AS date,
    dateDiff('second', activity_bounds.started_at, activity_bounds.ended_at) / 60.0 AS duration_minutes,
    activity_bounds.avg_hr AS avg_hr,
    user_profile.max_hr AS max_hr,
    coalesce(resting_by_activity.resting_hr, nullIf(user_profile.resting_hr, 0), 60) AS resting_hr
  FROM activity_bounds
  INNER JOIN ${databases.postgresFitness}.user_profile_current AS user_profile
    ON user_profile.id = activity_bounds.user_id
  LEFT JOIN resting_by_activity
    ON resting_by_activity.activity_id = activity_bounds.activity_id
   AND resting_by_activity.user_id = activity_bounds.user_id
  WHERE activity_bounds.activity_type IN (
      'cycling',
      'road_cycling',
      'mountain_biking',
      'gravel_cycling',
      'indoor_cycling',
      'virtual_cycling',
      'e_bike_cycling',
      'cyclocross',
      'track_cycling',
      'bmx',
      'hand_cycling',
      'running',
      'swimming',
      'walking',
      'hiking'
    )
    AND user_profile.max_hr IS NOT NULL
),
training_load AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    date,
    if(max_hr > resting_hr AND avg_hr > resting_hr,
      duration_minutes
      * intensity
      * 0.64 * exp(1.92 * intensity)
      / (60.0 * 0.85 * 0.64 * exp(1.92 * 0.85))
      * 100,
      0
    ) AS training_load
  FROM (
    SELECT
      activity_id,
      user_id,
      started_at,
      ended_at,
      date,
      duration_minutes,
      avg_hr,
      max_hr,
      resting_hr,
      if(
        max_hr > resting_hr,
        toFloat64(avg_hr - resting_hr) / toFloat64(max_hr - resting_hr),
        0
      ) AS intensity
    FROM activity_load
  )
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  training_load.activity_id AS activity_id,
  training_load.user_id AS user_id,
  training_load.started_at AS started_at,
  training_load.ended_at AS ended_at,
  training_load.date AS date,
  training_load.training_load AS training_load,
  0 AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM training_load
CROSS JOIN refresh_clock`;
}

function buildTestWeeklyEnduranceRampRateSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH daily_load AS (
  SELECT
    user_id,
    assumeNotNull(date) AS load_date,
    sum(training_load) AS training_load
  FROM ${databases.analytics}.daily_endurance_load
  WHERE is_deleted = 0
    AND date IS NOT NULL
  GROUP BY
    user_id,
    load_date
),
date_bounds AS (
  SELECT
    user_id,
    min(load_date) AS first_load_date,
    max(load_date) AS latest_load_date
  FROM daily_load
  GROUP BY user_id
),
date_series AS (
  SELECT
    user_id,
    first_load_date + INTERVAL date_offset DAY AS date
  FROM date_bounds
  ARRAY JOIN range(
    toUInt32(dateDiff('day', first_load_date, latest_load_date) + 1)
  ) AS date_offset
),
ctl_by_date AS (
  SELECT
    date_series.user_id AS user_id,
    date_series.date AS date,
    sum(
      daily_load.training_load
      * (1.0 / 42.0)
      * pow(41.0 / 42.0, dateDiff('day', daily_load.load_date, date_series.date))
    ) AS ctl
  FROM date_series
  LEFT JOIN daily_load
    ON daily_load.user_id = date_series.user_id
    AND daily_load.load_date <= date_series.date
  GROUP BY
    date_series.user_id,
    date_series.date
),
weekly_ctl AS (
  SELECT
    user_id,
    toMonday(date) AS week,
    argMax(ctl, date) AS ctl_end
  FROM ctl_by_date
  GROUP BY
    user_id,
    toMonday(date)
),
weekly_with_previous AS (
  SELECT
    user_id,
    week,
    ctl_end,
    lagInFrame(toNullable(ctl_end), 1, CAST(NULL, 'Nullable(Float64)')) OVER (
      PARTITION BY user_id ORDER BY week
    ) AS previous_ctl_end
  FROM weekly_ctl
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  weekly_with_previous.user_id AS user_id,
  weekly_with_previous.week AS week,
  round(weekly_with_previous.previous_ctl_end, 2) AS ctl_start,
  round(weekly_with_previous.ctl_end, 2) AS ctl_end,
  round(weekly_with_previous.ctl_end - weekly_with_previous.previous_ctl_end, 2) AS ramp_rate,
  0 AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM weekly_with_previous
CROSS JOIN refresh_clock
WHERE weekly_with_previous.previous_ctl_end IS NOT NULL`;
}

function buildTestWeeklyTrainingMonotonySelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH daily_load AS (
  SELECT
    user_id,
    assumeNotNull(date) AS load_date,
    sum(training_load) AS training_load
  FROM ${databases.analytics}.daily_endurance_load
  WHERE is_deleted = 0
    AND date IS NOT NULL
  GROUP BY
    user_id,
    load_date
),
weekly_stats AS (
  SELECT
    user_id,
    toMonday(load_date) AS week,
    avg(training_load) AS mean_load,
    stddevPop(training_load) AS stdev_load,
    sum(training_load) AS weekly_load
  FROM daily_load
  GROUP BY
    user_id,
    toMonday(load_date)
  HAVING stddevPop(training_load) > 1e-6
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  weekly_stats.user_id AS user_id,
  weekly_stats.week AS week,
  round(weekly_stats.mean_load / weekly_stats.stdev_load, 2) AS monotony,
  round(weekly_stats.weekly_load * (weekly_stats.mean_load / weekly_stats.stdev_load), 1) AS strain,
  round(weekly_stats.weekly_load, 1) AS weekly_load,
  0 AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM weekly_stats
CROSS JOIN refresh_clock`;
}

function buildTestDailyBodyMeasurementSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH body_source AS (
  SELECT
    id AS measurement_id,
    user_id,
    recorded_at,
    weight_kg,
    body_fat_pct
  FROM ${databases.analytics}.v_body_measurement
  WHERE weight_kg IS NOT NULL
    AND weight_kg > 0
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  CAST(body_source.measurement_id, 'UUID') AS measurement_id,
  CAST(body_source.user_id, 'UUID') AS user_id,
  CAST(toDate(body_source.recorded_at), 'Date') AS date,
  body_source.recorded_at AS recorded_at,
  body_source.weight_kg AS weight_kg,
  body_source.body_fat_pct AS body_fat_pct,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM body_source
CROSS JOIN refresh_clock`;
}

function buildTestRecoveryReadModelSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `SELECT
  user_id,
  date,
  hrv,
  resting_hr,
  respiratory_rate,
  efficiency_pct,
  hrv_mean_30d,
  hrv_sd_30d,
  rhr_mean_30d,
  rhr_sd_30d,
  rr_mean_30d,
  rr_sd_30d,
  hrv_mean_60d,
  hrv_sd_60d,
  rhr_mean_60d,
  rhr_sd_60d,
  CAST(NULL, 'Nullable(Float64)') AS hrv_score,
  CAST(NULL, 'Nullable(Float64)') AS resting_hr_score,
  CAST(NULL, 'Nullable(Float64)') AS sleep_score,
  CAST(NULL, 'Nullable(Float64)') AS respiratory_rate_score,
  refresh_version,
  refreshed_at
FROM ${databases.analytics}.daily_recovery_inputs`;
}

function buildTestStrainReadModelSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_load AS (
  SELECT
    user_id,
    toDate(started_at) AS date,
    coalesce(sum(daily_load), 0) AS daily_load
  FROM ${databases.analytics}.daily_activity_load
  GROUP BY user_id, toDate(started_at)
),
date_bounds AS (
  SELECT
    user_id,
    min(date) AS min_date,
    greatest(max(date), today()) AS max_date
  FROM activity_load
  GROUP BY user_id
),
date_series AS (
  SELECT
    date_bounds.user_id AS user_id,
    date_bounds.min_date + INTERVAL number DAY AS date
  FROM date_bounds
  ARRAY JOIN range(toUInt32(dateDiff('day', min_date, max_date) + 1)) AS number
),
daily AS (
  SELECT
    date_series.user_id AS user_id,
    date_series.date AS date,
    coalesce(activity_load.daily_load, 0) AS daily_load
  FROM date_series
  LEFT JOIN activity_load
    ON activity_load.user_id = date_series.user_id
   AND activity_load.date = date_series.date
),
with_windows AS (
  SELECT
    user_id,
    date,
    daily_load,
    sum(daily_load) OVER (PARTITION BY user_id ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load_7d,
    avg(daily_load) OVER (PARTITION BY user_id ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) * 7 AS chronic_load_28d,
    count() OVER (PARTITION BY user_id ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_count
  FROM daily
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  user_id,
  date,
  daily_load,
  least(21, round(2.775 * log(1 + greatest(daily_load, 0)), 1)) AS strain,
  acute_load_7d,
  chronic_load_28d,
  if(chronic_load_28d > 0 AND chronic_count = 28, acute_load_7d / chronic_load_28d, NULL) AS workload_ratio,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM with_windows
CROSS JOIN refresh_clock`;
}

function buildTestHealthspanReadModelSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH week_keys AS (
  SELECT
    user_id,
    toMonday(date) AS week_start
  FROM ${databases.analytics}.v_daily_metrics
  GROUP BY user_id, toMonday(date)
  UNION DISTINCT
  SELECT
    user_id,
    toMonday(toDate(started_at)) AS week_start
  FROM ${databases.analytics}.healthspan_activity_zone_minutes FINAL
  WHERE is_deleted = 0
    AND started_at IS NOT NULL
  GROUP BY user_id, toMonday(toDate(started_at))
  UNION DISTINCT
  SELECT
    user_id,
    toMonday(date) AS week_start
  FROM ${databases.analytics}.daily_body_measurement
  GROUP BY user_id, toMonday(date)
),
metrics AS (
  SELECT
    user_id,
    toMonday(date) AS week_start,
    avg(steps) AS avg_steps,
    CAST(coalesce(sum(exercise_minutes), 0), 'Float64') AS weekly_aerobic_min
  FROM ${databases.analytics}.v_daily_metrics
  GROUP BY user_id, toMonday(date)
),
zone_minutes AS (
  SELECT
    user_id,
    toMonday(toDate(started_at)) AS week_start,
    CAST(sum(aerobic_minutes), 'Float64') AS weekly_aerobic_min,
    CAST(sum(high_intensity_minutes), 'Float64') AS weekly_high_intensity_min
  FROM ${databases.analytics}.healthspan_activity_zone_minutes FINAL
  WHERE is_deleted = 0
    AND started_at IS NOT NULL
  GROUP BY user_id, toMonday(toDate(started_at))
),
body_by_week AS (
  SELECT
    user_id,
    toMonday(date) AS week_start,
    argMax(weight_kg, (recorded_at, refresh_version, measurement_id)) AS weight_kg,
    argMax(body_fat_pct, (recorded_at, refresh_version, measurement_id)) AS body_fat_pct
  FROM ${databases.analytics}.daily_body_measurement
  GROUP BY user_id, toMonday(date)
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  week_keys.user_id AS user_id,
  week_keys.week_start AS week_start,
  CAST(NULL, 'Nullable(Float64)') AS avg_sleep_min,
  CAST(NULL, 'Nullable(Float64)') AS bedtime_stddev_min,
  CAST(NULL, 'Nullable(Float64)') AS avg_resting_hr,
  metrics.avg_steps AS avg_steps,
  CAST(NULL, 'Nullable(Float64)') AS latest_vo2max,
  greatest(
    coalesce(metrics.weekly_aerobic_min, toFloat64(0)),
    coalesce(zone_minutes.weekly_aerobic_min, toFloat64(0))
  ) AS weekly_aerobic_min,
  coalesce(zone_minutes.weekly_high_intensity_min, toFloat64(0)) AS weekly_high_intensity_min,
  CAST(NULL, 'Nullable(Float64)') AS sessions_per_week,
  body_by_week.weight_kg AS weight_kg,
  body_by_week.body_fat_pct AS body_fat_pct,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM week_keys
LEFT JOIN metrics
  ON metrics.user_id = week_keys.user_id
 AND metrics.week_start = week_keys.week_start
LEFT JOIN zone_minutes
  ON zone_minutes.user_id = week_keys.user_id
 AND zone_minutes.week_start = week_keys.week_start
LEFT JOIN body_by_week
  ON body_by_week.user_id = week_keys.user_id
 AND body_by_week.week_start = week_keys.week_start
CROSS JOIN refresh_clock`;
}

function buildTestHealthspanActivityZoneMinutesSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
  return `WITH activity_bounds AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    assumeNotNull(ended_at) AS ended_at,
    dateDiff('second', started_at, assumeNotNull(ended_at)) / 60.0 AS duration_minutes
  FROM ${databases.analytics}.activity_summary
  WHERE ended_at IS NOT NULL
),
resting_by_activity AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    argMax(resting.resting_hr, toDate(resting.ended_at)) AS resting_hr
  FROM activity_bounds
  INNER JOIN ${databases.analytics}.resting_heart_rate_sleep_window AS resting FINAL
    ON resting.user_id = activity_bounds.user_id
   AND toDate(resting.ended_at) <= toDate(activity_bounds.started_at)
  WHERE resting.is_deleted = 0
    AND resting.ended_at IS NOT NULL
    AND resting.resting_hr IS NOT NULL
  GROUP BY activity_bounds.activity_id
),
activity_metadata AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    activity_bounds.user_id AS user_id,
    activity_bounds.started_at AS started_at,
    activity_bounds.ended_at AS ended_at,
    activity_bounds.duration_minutes AS duration_minutes,
    user_profile.max_hr AS max_hr,
    user_profile.ftp AS ftp,
    coalesce(resting_by_activity.resting_hr, user_profile.resting_hr) AS resting_hr
  FROM activity_bounds
  INNER JOIN ${databases.postgresFitness}.user_profile_current AS user_profile
    ON user_profile.id = activity_bounds.user_id
  LEFT JOIN resting_by_activity
    ON resting_by_activity.activity_id = activity_bounds.activity_id
  WHERE user_profile.max_hr IS NOT NULL OR user_profile.ftp IS NOT NULL
),
sensor_counts AS (
  SELECT
    activity_metadata.activity_id AS activity_id,
    activity_metadata.user_id AS user_id,
    any(activity_metadata.started_at) AS started_at,
    any(activity_metadata.ended_at) AS ended_at,
    any(activity_metadata.duration_minutes) AS duration_minutes,
    any(activity_metadata.max_hr) AS max_hr,
    any(activity_metadata.ftp) AS ftp,
    any(activity_metadata.resting_hr) AS resting_hr,
    countIf(sensor_samples.channel = 'heart_rate') AS heart_rate_sample_count,
    countIf(sensor_samples.channel = 'power') AS power_sample_count,
    countIf(
      sensor_samples.channel = 'heart_rate'
      AND activity_metadata.resting_hr IS NOT NULL
      AND sensor_samples.scalar
        < activity_metadata.resting_hr
        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
    ) AS aerobic_sample_count,
    countIf(
      sensor_samples.channel = 'heart_rate'
      AND activity_metadata.resting_hr IS NOT NULL
      AND sensor_samples.scalar
        >= activity_metadata.resting_hr
        + (activity_metadata.max_hr - activity_metadata.resting_hr) * 0.8
    ) AS heart_rate_high_intensity_sample_count,
    countIf(
      sensor_samples.channel = 'power'
      AND activity_metadata.ftp IS NOT NULL
      AND sensor_samples.scalar >= activity_metadata.ftp * 0.9
    ) AS power_high_intensity_sample_count
  FROM activity_metadata
  INNER JOIN ${databases.analytics}.activity_sensor_sample AS sensor_samples
    ON sensor_samples.activity_id = activity_metadata.activity_id
   AND sensor_samples.user_id = activity_metadata.user_id
  WHERE sensor_samples.channel IN ('heart_rate', 'power')
    AND sensor_samples.scalar IS NOT NULL
    AND sensor_samples.is_deleted = 0
  GROUP BY activity_metadata.activity_id, activity_metadata.user_id
),
zone_minutes AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    if(
      max_hr IS NOT NULL
      AND resting_hr IS NOT NULL
      AND heart_rate_sample_count > 0,
      toFloat64(aerobic_sample_count) / toFloat64(heart_rate_sample_count) * duration_minutes,
      0
    ) AS aerobic_minutes,
    greatest(
      if(
        max_hr IS NOT NULL
        AND resting_hr IS NOT NULL
        AND heart_rate_sample_count > 0,
        toFloat64(heart_rate_high_intensity_sample_count)
          / toFloat64(heart_rate_sample_count) * duration_minutes,
        0
      ),
      if(
        ftp IS NOT NULL
        AND power_sample_count > 0,
        toFloat64(power_high_intensity_sample_count)
          / toFloat64(power_sample_count) * duration_minutes,
        0
      )
    ) AS high_intensity_minutes
  FROM sensor_counts
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
)
SELECT
  zone_minutes.activity_id AS activity_id,
  zone_minutes.user_id AS user_id,
  zone_minutes.started_at AS started_at,
  zone_minutes.ended_at AS ended_at,
  zone_minutes.aerobic_minutes AS aerobic_minutes,
  zone_minutes.high_intensity_minutes AS high_intensity_minutes,
  toUInt8(0) AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM zone_minutes
CROSS JOIN refresh_clock`;
}

function rewriteClickHouseTestCommand(
  query: string,
  databases: IsolatedClickHouseDatabases,
  precomputedAnalyticsSelectByName: Map<string, string>,
): string[] {
  const rewrittenQuery = rewriteClickHouseDatabaseNames(query, databases).trim();
  const viewMatch = rewrittenQuery.match(CLICKHOUSE_TEST_VIEW_REGEX);

  if (viewMatch) {
    const viewName = viewMatch[1];
    const selectSql = viewMatch[2];
    if (!viewName || !selectSql) {
      throw new Error("Could not parse ClickHouse test view statement");
    }
    const trimmedSelectSql = selectSql.trim();
    precomputedAnalyticsSelectByName.set(
      viewName,
      buildTestAnalyticsSelectSql(viewName, trimmedSelectSql, databases),
    );
    return [buildTestAnalyticsTableStatement(viewName)];
  }

  if (
    rewrittenQuery.startsWith(
      `CREATE TABLE IF NOT EXISTS ${databases.analytics}.resting_heart_rate_sleep_window`,
    )
  ) {
    precomputedAnalyticsSelectByName.set(
      `${databases.analytics}.resting_heart_rate_sleep_window`,
      buildTestRestingHeartRateSelectSql(databases),
    );
  }

  if (rewrittenQuery.startsWith(`DROP VIEW IF EXISTS ${databases.analytics}.`)) {
    return [rewrittenQuery.replace("DROP VIEW IF EXISTS", "DROP TABLE IF EXISTS")];
  }

  const rebuildAnalyticsPrefix = `REBUILD TEST ANALYTICS TABLE ${databases.analytics}.`;
  if (rewrittenQuery.startsWith(rebuildAnalyticsPrefix)) {
    const viewName = rewrittenQuery.slice("REBUILD TEST ANALYTICS TABLE ".length);
    const selectSql = precomputedAnalyticsSelectByName.get(viewName);
    if (!selectSql) {
      throw new Error(`Missing ClickHouse test analytics SELECT for ${viewName}`);
    }
    return [`TRUNCATE TABLE ${viewName}`, `INSERT INTO ${viewName}\n${selectSql}`];
  }

  return [rewrittenQuery];
}

function buildTestAnalyticsSelectSql(
  viewName: string,
  selectSql: string,
  databases: IsolatedClickHouseDatabases,
): string {
  if (
    viewName.endsWith(".activity_summary") &&
    selectSql.includes(".activity_summary_rows FINAL")
  ) {
    return buildTestActivitySummarySelectSql(databases);
  }
  if (viewName.endsWith(".provider_stats")) {
    return buildTestProviderStatsSelectSql(selectSql);
  }
  return selectSql;
}

function createIsolatedClickHouseClient(
  client: ClickHouseClient,
  databases: IsolatedClickHouseDatabases,
): ClickHouseClient {
  const precomputedAnalyticsSelectByName = new Map<string, string>();
  return {
    command: async (options) => {
      const queries = rewriteClickHouseTestCommand(
        options.query,
        databases,
        precomputedAnalyticsSelectByName,
      );
      let result: unknown;
      for (const query of queries) {
        try {
          result = await client.command({
            ...options,
            query,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`ClickHouse test command failed: ${query}\n${message}`);
        }
      }
      return result;
    },
    query: <TRow extends object>(options: {
      query: string;
      format: "JSONEachRow";
      query_params?: Record<string, unknown>;
    }) =>
      client.query<TRow>({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
      }),
    close: () => client.close?.() ?? Promise.resolve(),
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function removeStaleClickHouseTestSetupSlot(slotPath: string): Promise<void> {
  try {
    const lockStats = await stat(slotPath);
    if (Date.now() - lockStats.mtimeMs > clickHouseTestSetupStaleSlotMilliseconds) {
      await rm(slotPath, { force: true, recursive: true });
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function acquireClickHouseTestSetupSlot(): Promise<() => Promise<void>> {
  await mkdir(clickHouseTestSetupSemaphoreDirectory, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    for (let slotIndex = 0; slotIndex < clickHouseTestSetupSlotCount; slotIndex += 1) {
      const slotPath = join(clickHouseTestSetupSemaphoreDirectory, `slot-${slotIndex}`);
      await removeStaleClickHouseTestSetupSlot(slotPath);
      try {
        await mkdir(slotPath);
        return async () => {
          await rm(slotPath, { force: true, recursive: true });
        };
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
    }

    if (Date.now() - startedAt > clickHouseTestSetupSlotTimeoutMilliseconds) {
      throw new Error("Timed out waiting for ClickHouse integration test setup slot");
    }
    await sleep(250);
  }
}

export async function createClickHouseTestActivitySensorStore(
  testContext: ClickHouseSyncTestContext,
): Promise<ActivitySensorStore> {
  const suffix = randomBytes(6).toString("hex");
  const databases = {
    analytics: `analytics_test_${suffix}`,
    ingest: `ingest_test_${suffix}`,
    postgresFitness: `postgres_fitness_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const setupClient = createIsolatedClickHouseClient(rawClient, databases);
  const client = setupClient;
  handlesByContext.set(testContext, { client, setupClient });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.ingest} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.postgresFitness} SYNC` });
    await rawClient.close?.();
  });

  const releaseSlot = await acquireClickHouseTestSetupSlot();
  try {
    await bootstrapClickHouseTestSchema(setupClient, testContext.connectionString);
    await syncClickHouseTestActivitySensorStoreWithClient(
      setupClient,
      testContext.connectionString,
    );
  } finally {
    await releaseSlot();
  }

  return new ClickHouseActivitySensorStore(client);
}

async function bootstrapClickHouseTestSchema(
  client: ClickHouseClient,
  connectionString: string,
): Promise<void> {
  const defaultTestDatabases: IsolatedClickHouseDatabases = {
    analytics: "analytics",
    ingest: "ingest",
    postgresFitness: "postgres_fitness",
  };

  for (const statement of buildClickHouseBootstrapStatements(connectionString)) {
    await client.command({ query: statement });
  }
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.deduped_activities
AS
${buildTestDedupedActivitiesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_sensor_sample
AS
${buildTestActivitySensorSampleSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_location_sample
AS
${buildTestActivityLocationSampleSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_stream_points
AS
${buildTestActivityStreamPointsSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_heart_rate_zones
AS
${buildTestActivityHeartRateZonesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.hiking_activity
AS
${buildTestHikingActivitySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_recovery_inputs
AS
${buildTestDailyRecoveryInputsSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_sleep
AS
${buildTestDailySleepSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_recovery
AS
${buildTestRecoveryReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_endurance_load
AS
${buildTestDailyEnduranceLoadSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_endurance_ramp_rate
AS
${buildTestWeeklyEnduranceRampRateSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_training_monotony
AS
${buildTestWeeklyTrainingMonotonySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_activity_load
AS
${buildTestDailyActivityLoadSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_strain
AS
${buildTestStrainReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_body_measurement
AS
${buildTestDailyBodyMeasurementSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.healthspan_activity_zone_minutes
AS
${buildTestHealthspanActivityZoneMinutesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_healthspan
AS
${buildTestHealthspanReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({ query: buildActivityVo2MaxEstimateTableSql() });

  // Dbt read model tables — created here as empty ReplacingMergeTree tables so
  // repositories can query them without errors. The fallback path handles
  // empty results from these tables.
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_power_curve"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_aerobic_efficiency"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_polarization_zones"),
  });
}

export async function syncClickHouseTestActivitySensorStore(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const releaseSlot = await acquireClickHouseTestSetupSlot();
  try {
    await syncClickHouseTestActivitySensorStoreWithSlot(testContext);
  } finally {
    await releaseSlot();
  }
}

async function syncClickHouseTestActivitySensorStoreWithSlot(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await syncClickHouseTestActivitySensorStoreWithClient(
    handle.setupClient,
    testContext.connectionString,
  );
}

async function syncClickHouseTestActivitySensorStoreWithClient(
  client: ClickHouseClient,
  connectionString: string,
): Promise<void> {
  for (const rawTableSync of rawTableSyncs) {
    await client.command({
      query: `TRUNCATE TABLE postgres_fitness.${rawTableSync.tableName}`,
    });
    await client.command({
      query: buildRawTableInsertStatement(connectionString, rawTableSync),
    });
  }

  await rebuildClickHouseSensorAnalyticsWithClient(client);
}

function formatNullableClickHouseString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return clickHouseStringLiteral(value);
}

function formatNullableClickHouseUuid(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `toUUID(${clickHouseStringLiteral(value)})`;
}

function formatNullableClickHouseFloat(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return String(value);
}

function formatClickHouseVector(value: readonly number[] | null | undefined): string {
  if (!value || value.length === 0) {
    return "[]";
  }
  return `[${value.join(",")}]`;
}

function formatClickHouseMetricStreamSeedValue(row: ClickHouseMetricStreamSeedRow): string {
  const id = row.id ?? randomUUID();
  return `(
    toUUID(${clickHouseStringLiteral(id)}),
    ${formatNullableClickHouseUuid(row.activityId)},
    toUUID(${clickHouseStringLiteral(row.userId)}),
    parseDateTime64BestEffort(${clickHouseStringLiteral(row.recordedAt)}, 6, 'UTC'),
    ${clickHouseStringLiteral(row.channel)},
    ${clickHouseStringLiteral(row.providerId)},
    ${formatNullableClickHouseString(row.externalId)},
    ${formatNullableClickHouseString(row.deviceId)},
    ${formatNullableClickHouseString(row.sourceType)},
    ${formatNullableClickHouseFloat(row.scalar)},
    ${formatClickHouseVector(row.vector)},
    ${formatNullableClickHouseString(row.point ?? "")},
    ${formatNullableClickHouseString(row.metadata ?? "")},
    now64(9),
    0,
    1
  )`;
}

export async function insertClickHouseMetricStreamRows(
  testContext: ClickHouseSyncTestContext,
  rows: readonly ClickHouseMetricStreamSeedRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await handle.setupClient.command({
    query: `INSERT INTO ingest.metric_stream (
      id,
      activity_id,
      user_id,
      recorded_at,
      channel,
      provider_id,
      external_id,
      device_id,
      source_type,
      scalar,
      vector,
      point,
      metadata,
      ingested_at,
      is_deleted,
      version
    ) VALUES ${rows.map(formatClickHouseMetricStreamSeedValue).join(",\n")}`,
  });
}

export async function rebuildClickHouseSensorAnalytics(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await rebuildClickHouseSensorAnalyticsWithClient(handle.setupClient);
}

export async function executeClickHouseTestCommand(
  testContext: ClickHouseSyncTestContext,
  query: string,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await handle.setupClient.command({ query });
}

export async function seedClickHouseMetricStreamRows(
  testContext: ClickHouseSyncTestContext,
  rows: readonly ClickHouseMetricStreamSeedRow[],
): Promise<void> {
  await insertClickHouseMetricStreamRows(testContext, rows);
  await rebuildClickHouseSensorAnalytics(testContext);
}

async function rebuildClickHouseSensorAnalyticsWithClient(client: ClickHouseClient): Promise<void> {
  await client.command({ query: "TRUNCATE TABLE analytics.sensor_scalar_sample" });
  await client.command({ query: "TRUNCATE TABLE analytics.deduped_sensor" });
  await client.command({ query: "TRUNCATE TABLE analytics.deduped_activities" });
  await client.command({ query: "TRUNCATE TABLE analytics.activity_vo2max_estimate" });
  await client.command({ query: buildSensorScalarSampleBackfillSql() });
  await client.command({ query: buildDedupedSensorBackfillSql() });

  for (const viewName of analyticsBuildOrder) {
    await client.command({ query: `REBUILD TEST ANALYTICS TABLE ${viewName}` });
  }
}
