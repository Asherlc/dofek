import { randomBytes } from "node:crypto";
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

interface IsolatedClickHouseDatabases {
  analytics: string;
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
    tableName: "metric_stream",
    columns: [
      "id",
      "activity_id",
      "user_id",
      "recorded_at",
      "channel",
      "provider_id",
      "external_id",
      "device_id",
      "source_type",
      "scalar",
    ],
  },
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
      "cycling_distance_km",
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
const analyticsBuildOrder = [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.provider_stats",
  "analytics.deduped_activities",
  "analytics.resting_heart_rate_sleep_window",
  "analytics.deduped_location",
  "analytics.activity_sensor_sample",
  "analytics.activity_summary",
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
    .replace(/\banalytics\b/g, databases.analytics);
}

function buildTestAnalyticsTableStatement(viewName: "analytics.deduped_activities"): string;
function buildTestAnalyticsTableStatement(viewName: string): string | null;
function buildTestAnalyticsTableStatement(viewName: string): string | null {
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
last_sample_at DateTime64(6, 'UTC')`,
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
  };
  const shortViewName = viewName.split(".").at(-1);
  if (!shortViewName) {
    return null;
  }
  const columnDefinitions = columnDefinitionsByViewName[shortViewName];
  if (!columnDefinitions) {
    return null;
  }
  const engine =
    shortViewName === "deduped_activities" ||
    shortViewName === "activity_sensor_sample" ||
    shortViewName === "provider_stats"
      ? "ReplacingMergeTree(refresh_version)"
      : "MergeTree";
  const orderBy =
    shortViewName === "deduped_activities"
      ? "(user_id, activity_id)"
      : shortViewName === "activity_sensor_sample"
        ? "(user_id, activity_id, recorded_date, channel, recorded_at)"
        : shortViewName === "provider_stats"
          ? "(user_id, provider_id)"
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

function rewriteClickHouseTestCommand(
  query: string,
  databases: IsolatedClickHouseDatabases,
  precomputedAnalyticsSelectByName: Map<string, string>,
): string[] {
  const rewrittenQuery = rewriteClickHouseDatabaseNames(query, databases).trim();
  const viewMatch = rewrittenQuery.match(
    /^CREATE VIEW IF NOT EXISTS ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\nAS\n?([\s\S]*)$/,
  );

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
    const tableStatement = buildTestAnalyticsTableStatement(viewName);
    if (!tableStatement) {
      throw new Error(`Missing ClickHouse test analytics table schema for ${viewName}`);
    }
    return [tableStatement];
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
    postgresFitness: `postgres_fitness_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const setupClient = createIsolatedClickHouseClient(rawClient, databases);
  const client = setupClient;
  handlesByContext.set(testContext, { client, setupClient });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
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
  for (const statement of buildClickHouseBootstrapStatements(connectionString)) {
    await client.command({ query: statement });
  }
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.deduped_activities
AS
${buildTestDedupedActivitiesSelectSql({
  analytics: "analytics",
  postgresFitness: "postgres_fitness",
})}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_sensor_sample
AS
${buildTestActivitySensorSampleSelectSql({
  analytics: "analytics",
  postgresFitness: "postgres_fitness",
})}`,
  });
  await client.command({ query: buildActivityVo2MaxEstimateTableSql() });
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
