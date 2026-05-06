import { createClient } from "@clickhouse/client";

export interface ClickHouseCommandClient {
  command(options: {
    query: string;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query?<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<TRow[]> }>;
  close?(): Promise<void>;
}

export interface ClickHouseClient extends ClickHouseCommandClient {
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<TRow[]> }>;
}

interface ClickHouseClientOptions {
  requestTimeoutMs?: number;
}

interface TableCountRow {
  table_count: number | string;
}

const CLICKHOUSE_TABLE_WAIT_ATTEMPTS = 180;
const CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS = 120_000;

interface ClickHousePostgresConnection {
  hostAndPort: string;
  database: string;
  user: string;
  password: string;
}

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function normalizePostgresHostForClickHouse(hostname: string): string {
  const normalizedHostname = hostname === "[::1]" ? "::1" : hostname;
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  ) {
    return "host.docker.internal";
  }
  return normalizedHostname;
}

const peerDbMetadataColumnDefinitions = `  _peerdb_synced_at DateTime64(9) DEFAULT now(),
  _peerdb_is_deleted Int8 DEFAULT 0,
  _peerdb_version Int64 DEFAULT 0`;

function replacingMergeTreeTable(orderBy: string): string {
  return `ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1`;
}

function buildPostgresFitnessRawTableStatements(): string[] {
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
  ];
}

function refreshableMergeTreeViewHeader(
  viewName: string,
  orderBy: string,
  refreshOffset = "",
): string {
  const offsetClause = refreshOffset ? ` OFFSET ${refreshOffset}` : "";
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${viewName}
REFRESH EVERY 1 MINUTE${offsetClause}
ENGINE = MergeTree
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1
AS`;
}

function buildActivityReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader("analytics.v_activity", "(user_id, started_at, id)")}
WITH
active_activity AS (
  SELECT *
  FROM postgres_fitness.activity FINAL
  WHERE _peerdb_is_deleted = 0
),
active_provider_priority AS (
  SELECT *
  FROM postgres_fitness.provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_device_priority AS (
  SELECT *
  FROM postgres_fitness.device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT activity_id, priority
  FROM (
    SELECT
      active_activity.id AS activity_id,
      active_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY active_activity.id
        ORDER BY length(active_device_priority.source_name_pattern) DESC
      ) AS row_number
    FROM active_activity
    INNER JOIN active_device_priority
      ON active_device_priority.provider_id = active_activity.provider_id
     AND active_activity.source_name LIKE active_device_priority.source_name_pattern
  )
  WHERE row_number = 1
),
ranked AS (
  SELECT
    active_activity.id AS id,
    active_activity.provider_id AS provider_id,
    active_activity.user_id AS user_id,
    active_activity.external_id AS external_id,
    active_activity.activity_type AS activity_type,
    active_activity.started_at AS started_at,
    active_activity.ended_at AS ended_at,
    active_activity.source_name AS source_name,
    active_activity.name AS name,
    active_activity.notes AS notes,
    active_activity.timezone AS timezone,
    active_activity.raw AS raw,
    coalesce(device_priority_match.priority, active_provider_priority.priority, 100) AS priority
  FROM active_activity
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_activity.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.activity_id = active_activity.id
),
pairs AS (
  SELECT
    left_activity.id AS id1,
    right_activity.id AS id2
  FROM ranked AS left_activity
  INNER JOIN ranked AS right_activity
    ON left_activity.user_id = right_activity.user_id
   AND toString(left_activity.id) < toString(right_activity.id)
   AND dateDiff(
      'second',
      greatest(left_activity.started_at, right_activity.started_at),
      least(
        coalesce(left_activity.ended_at, left_activity.started_at + INTERVAL 1 HOUR),
        coalesce(right_activity.ended_at, right_activity.started_at + INTERVAL 1 HOUR)
      )
    ) / nullIf(dateDiff(
      'second',
      least(left_activity.started_at, right_activity.started_at),
      greatest(
        coalesce(left_activity.ended_at, left_activity.started_at + INTERVAL 1 HOUR),
        coalesce(right_activity.ended_at, right_activity.started_at + INTERVAL 1 HOUR)
      )
    ), 0) > 0.8
),
final_groups AS (
  SELECT activity_id, min(group_id) AS group_id
  FROM (
    SELECT id AS activity_id, toString(id) AS group_id
    FROM ranked
    UNION ALL
    SELECT id1 AS activity_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
    UNION ALL
    SELECT id2 AS activity_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
  )
  GROUP BY activity_id
),
best AS (
  SELECT *
  FROM (
    SELECT
      final_groups.group_id AS group_id,
      ranked.id AS canonical_id,
      ranked.provider_id AS provider_id,
      ranked.user_id AS user_id,
      ranked.activity_type AS activity_type,
      ranked.started_at AS started_at,
      ranked.ended_at AS ended_at,
      ranked.source_name AS source_name,
      ranked.priority AS priority,
      row_number() OVER (
        PARTITION BY final_groups.group_id
        ORDER BY ranked.priority ASC, toString(ranked.id) ASC
      ) AS row_number
    FROM final_groups
    INNER JOIN ranked
      ON ranked.id = final_groups.activity_id
  )
  WHERE row_number = 1
),
merged AS (
  SELECT
    best.group_id AS group_id,
    best.canonical_id AS id,
    any(best.provider_id) AS provider_id,
    any(best.user_id) AS user_id,
    any(best.activity_type) AS activity_type,
    any(best.started_at) AS started_at,
    any(best.ended_at) AS ended_at,
    any(best.source_name) AS source_name,
    argMinIf(ranked.name, ranked.priority, ranked.name IS NOT NULL) AS name,
    argMinIf(ranked.notes, ranked.priority, ranked.notes IS NOT NULL) AS notes,
    argMinIf(ranked.timezone, ranked.priority, ranked.timezone IS NOT NULL) AS timezone,
    argMinIf(ranked.raw, ranked.priority, ranked.raw IS NOT NULL) AS raw,
    arraySort(groupUniqArray(ranked.provider_id)) AS source_providers,
    groupArrayIf(map('providerId', ranked.provider_id, 'externalId', ranked.external_id), ranked.external_id IS NOT NULL AND ranked.external_id != '') AS source_external_ids,
    groupArray(ranked.id) AS member_activity_ids
  FROM best
  INNER JOIN final_groups
    ON final_groups.group_id = best.group_id
  INNER JOIN ranked
    ON ranked.id = final_groups.activity_id
  GROUP BY best.group_id, best.canonical_id
)
SELECT
  id,
  provider_id,
  user_id,
  id AS primary_activity_id,
  activity_type,
  started_at,
  ended_at,
  source_name,
  name,
  notes,
  timezone,
  raw,
  source_providers,
  source_external_ids,
  member_activity_ids
FROM merged`;
}

function buildActivityMembersReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader(
    "analytics.v_activity_members",
    "(user_id, started_at, activity_id, member_activity_id)",
  )}
SELECT
  id AS activity_id,
  user_id,
  started_at,
  ended_at,
  arrayJoin(member_activity_ids) AS member_activity_id
FROM analytics.v_activity`;
}

function buildSleepReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader("analytics.v_sleep", "(user_id, started_at, id)")}
WITH
active_sleep AS (
  SELECT *
  FROM postgres_fitness.sleep_session FINAL
  WHERE _peerdb_is_deleted = 0
),
active_provider_priority AS (
  SELECT *
  FROM postgres_fitness.provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_device_priority AS (
  SELECT *
  FROM postgres_fitness.device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT sleep_id, sleep_priority, priority
  FROM (
    SELECT
      active_sleep.id AS sleep_id,
      active_device_priority.sleep_priority AS sleep_priority,
      active_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY active_sleep.id
        ORDER BY length(active_device_priority.source_name_pattern) DESC
      ) AS row_number
    FROM active_sleep
    INNER JOIN active_device_priority
      ON active_device_priority.provider_id = active_sleep.provider_id
     AND active_sleep.source_name LIKE active_device_priority.source_name_pattern
  )
  WHERE row_number = 1
),
ranked AS (
  SELECT
    active_sleep.id AS id,
    active_sleep.provider_id AS provider_id,
    active_sleep.user_id AS user_id,
    active_sleep.started_at AS started_at,
    active_sleep.ended_at AS ended_at,
    active_sleep.duration_minutes AS duration_minutes,
    active_sleep.deep_minutes AS deep_minutes,
    active_sleep.rem_minutes AS rem_minutes,
    active_sleep.light_minutes AS light_minutes,
    active_sleep.awake_minutes AS awake_minutes,
    active_sleep.efficiency_pct AS efficiency_pct,
    active_sleep.sleep_type AS sleep_type,
    active_sleep.source_name AS source_name,
    coalesce(device_priority_match.sleep_priority, active_provider_priority.sleep_priority, device_priority_match.priority, active_provider_priority.priority, 100) AS priority,
    multiIf(
      active_sleep.sleep_type IN ('nap', 'late_nap', 'rest'), true,
      active_sleep.sleep_type IN ('sleep', 'long_sleep', 'main'), false,
      active_sleep.sleep_type = 'not_main', coalesce(active_sleep.duration_minutes < 120, true),
      active_sleep.duration_minutes IS NOT NULL, active_sleep.duration_minutes < 120,
      false
    ) AS is_nap
  FROM active_sleep
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_sleep.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.sleep_id = active_sleep.id
),
pairs AS (
  SELECT
    left_sleep.id AS id1,
    right_sleep.id AS id2
  FROM ranked AS left_sleep
  INNER JOIN ranked AS right_sleep
    ON left_sleep.user_id = right_sleep.user_id
   AND left_sleep.is_nap = right_sleep.is_nap
   AND toString(left_sleep.id) < toString(right_sleep.id)
   AND dateDiff(
      'second',
      greatest(left_sleep.started_at, right_sleep.started_at),
      least(
        coalesce(left_sleep.ended_at, left_sleep.started_at + INTERVAL 8 HOUR),
        coalesce(right_sleep.ended_at, right_sleep.started_at + INTERVAL 8 HOUR)
      )
    ) / nullIf(dateDiff(
      'second',
      least(left_sleep.started_at, right_sleep.started_at),
      greatest(
        coalesce(left_sleep.ended_at, left_sleep.started_at + INTERVAL 8 HOUR),
        coalesce(right_sleep.ended_at, right_sleep.started_at + INTERVAL 8 HOUR)
      )
    ), 0) > 0.8
),
final_groups AS (
  SELECT sleep_id, min(group_id) AS group_id
  FROM (
    SELECT id AS sleep_id, toString(id) AS group_id
    FROM ranked
    UNION ALL
    SELECT id1 AS sleep_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
    UNION ALL
    SELECT id2 AS sleep_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
  )
  GROUP BY sleep_id
),
best AS (
  SELECT *
  FROM (
    SELECT
      final_groups.group_id AS group_id,
      ranked.id AS id,
      ranked.provider_id AS provider_id,
      ranked.user_id AS user_id,
      ranked.started_at AS started_at,
      ranked.ended_at AS ended_at,
      ranked.duration_minutes AS duration_minutes,
      ranked.deep_minutes AS deep_minutes,
      ranked.rem_minutes AS rem_minutes,
      ranked.light_minutes AS light_minutes,
      ranked.awake_minutes AS awake_minutes,
      ranked.efficiency_pct AS efficiency_pct,
      ranked.sleep_type AS sleep_type,
      ranked.source_name AS source_name,
      ranked.priority AS priority,
      ranked.is_nap AS is_nap,
      row_number() OVER (
        PARTITION BY final_groups.group_id
        ORDER BY ranked.priority ASC, toString(ranked.id) ASC
      ) AS row_number
    FROM final_groups
    INNER JOIN ranked
      ON ranked.id = final_groups.sleep_id
  )
  WHERE row_number = 1
)
SELECT
  best.id AS id,
  best.provider_id AS provider_id,
  best.user_id AS user_id,
  best.started_at AS started_at,
  best.ended_at AS ended_at,
  best.duration_minutes AS duration_minutes,
  best.deep_minutes AS deep_minutes,
  best.rem_minutes AS rem_minutes,
  best.light_minutes AS light_minutes,
  best.awake_minutes AS awake_minutes,
  coalesce(
    best.efficiency_pct,
    multiIf(
      best.provider_id = 'apple_health'
        AND best.duration_minutes > 0
        AND (best.deep_minutes IS NOT NULL OR best.rem_minutes IS NOT NULL OR best.light_minutes IS NOT NULL),
      round((coalesce(best.deep_minutes, 0) + coalesce(best.rem_minutes, 0) + coalesce(best.light_minutes, 0)) / best.duration_minutes * 100, 1),
      best.provider_id IN ('eight-sleep', 'polar') AND best.duration_minutes > 0 AND best.awake_minutes IS NOT NULL,
      round(best.duration_minutes / (best.duration_minutes + best.awake_minutes) * 100, 1),
      NULL
    )
  ) AS efficiency_pct,
  best.sleep_type AS sleep_type,
  best.is_nap AS is_nap,
  best.source_name AS source_name,
  arraySort(groupUniqArray(ranked.provider_id)) AS source_providers
FROM best
INNER JOIN final_groups
  ON final_groups.group_id = best.group_id
INNER JOIN ranked
  ON ranked.id = final_groups.sleep_id
GROUP BY
  best.id,
  best.provider_id,
  best.user_id,
  best.started_at,
  best.ended_at,
  best.duration_minutes,
  best.deep_minutes,
  best.rem_minutes,
  best.light_minutes,
  best.awake_minutes,
  best.efficiency_pct,
  best.sleep_type,
  best.is_nap,
  best.source_name`;
}

function buildBodyMeasurementReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader(
    "analytics.v_body_measurement",
    "(user_id, recorded_at, id)",
  )}
WITH
active_body AS (
  SELECT *
  FROM postgres_fitness.body_measurement FINAL
  WHERE _peerdb_is_deleted = 0
),
active_provider_priority AS (
  SELECT *
  FROM postgres_fitness.provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_device_priority AS (
  SELECT *
  FROM postgres_fitness.device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT measurement_id, body_priority, priority
  FROM (
    SELECT
      active_body.id AS measurement_id,
      active_device_priority.body_priority AS body_priority,
      active_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY active_body.id
        ORDER BY length(active_device_priority.source_name_pattern) DESC
      ) AS row_number
    FROM active_body
    INNER JOIN active_device_priority
      ON active_device_priority.provider_id = active_body.provider_id
     AND active_body.source_name LIKE active_device_priority.source_name_pattern
  )
  WHERE row_number = 1
),
ranked AS (
  SELECT
    active_body.id AS id,
    active_body.provider_id AS provider_id,
    active_body.user_id AS user_id,
    active_body.recorded_at AS recorded_at,
    active_body.weight_kg AS weight_kg,
    active_body.body_fat_pct AS body_fat_pct,
    active_body.muscle_mass_kg AS muscle_mass_kg,
    active_body.bmi AS bmi,
    active_body.systolic_bp AS systolic_bp,
    active_body.diastolic_bp AS diastolic_bp,
    active_body.temperature_c AS temperature_c,
    active_body.height_cm AS height_cm,
    coalesce(device_priority_match.body_priority, active_provider_priority.body_priority, device_priority_match.priority, active_provider_priority.priority, 100) AS priority
  FROM active_body
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_body.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.measurement_id = active_body.id
),
pairs AS (
  SELECT left_body.id AS id1, right_body.id AS id2
  FROM ranked AS left_body
  INNER JOIN ranked AS right_body
    ON left_body.user_id = right_body.user_id
   AND toString(left_body.id) < toString(right_body.id)
   AND abs(dateDiff('second', left_body.recorded_at, right_body.recorded_at)) < 300
),
final_groups AS (
  SELECT measurement_id, min(group_id) AS group_id
  FROM (
    SELECT id AS measurement_id, toString(id) AS group_id
    FROM ranked
    UNION ALL
    SELECT id1 AS measurement_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
    UNION ALL
    SELECT id2 AS measurement_id, least(toString(id1), toString(id2)) AS group_id
    FROM pairs
  )
  GROUP BY measurement_id
),
best AS (
  SELECT *
  FROM (
    SELECT
      final_groups.group_id AS group_id,
      ranked.id AS id,
      ranked.provider_id AS provider_id,
      ranked.user_id AS user_id,
      ranked.recorded_at AS recorded_at,
      ranked.priority AS priority,
      row_number() OVER (
        PARTITION BY final_groups.group_id
        ORDER BY ranked.priority ASC, toString(ranked.id) ASC
      ) AS row_number
    FROM final_groups
    INNER JOIN ranked
      ON ranked.id = final_groups.measurement_id
  )
  WHERE row_number = 1
)
SELECT
  best.id AS id,
  best.provider_id AS provider_id,
  best.user_id AS user_id,
  best.recorded_at AS recorded_at,
  argMinIf(ranked.weight_kg, ranked.priority, ranked.weight_kg IS NOT NULL) AS weight_kg,
  argMinIf(ranked.body_fat_pct, ranked.priority, ranked.body_fat_pct IS NOT NULL) AS body_fat_pct,
  argMinIf(ranked.muscle_mass_kg, ranked.priority, ranked.muscle_mass_kg IS NOT NULL) AS muscle_mass_kg,
  argMinIf(ranked.bmi, ranked.priority, ranked.bmi IS NOT NULL) AS bmi,
  argMinIf(ranked.systolic_bp, ranked.priority, ranked.systolic_bp IS NOT NULL) AS systolic_bp,
  argMinIf(ranked.diastolic_bp, ranked.priority, ranked.diastolic_bp IS NOT NULL) AS diastolic_bp,
  argMinIf(ranked.temperature_c, ranked.priority, ranked.temperature_c IS NOT NULL) AS temperature_c,
  argMinIf(ranked.height_cm, ranked.priority, ranked.height_cm IS NOT NULL) AS height_cm,
  arraySort(groupUniqArray(ranked.provider_id)) AS source_providers
FROM best
INNER JOIN final_groups
  ON final_groups.group_id = best.group_id
INNER JOIN ranked
  ON ranked.id = final_groups.measurement_id
GROUP BY best.id, best.provider_id, best.user_id, best.recorded_at`;
}

function buildDailyMetricsReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader("analytics.v_daily_metrics", "(user_id, date)")}
WITH
active_daily_metrics AS (
  SELECT *
  FROM postgres_fitness.daily_metrics FINAL
  WHERE _peerdb_is_deleted = 0
),
active_provider_priority AS (
  SELECT *
  FROM postgres_fitness.provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_device_priority AS (
  SELECT *
  FROM postgres_fitness.device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT daily_metrics_id, recovery_priority, daily_activity_priority, priority
  FROM (
    SELECT
      active_daily_metrics.id AS daily_metrics_id,
      active_device_priority.recovery_priority AS recovery_priority,
      active_device_priority.daily_activity_priority AS daily_activity_priority,
      active_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY active_daily_metrics.id
        ORDER BY length(active_device_priority.source_name_pattern) DESC
      ) AS row_number
    FROM active_daily_metrics
    INNER JOIN active_device_priority
      ON active_device_priority.provider_id = active_daily_metrics.provider_id
     AND active_daily_metrics.source_name LIKE active_device_priority.source_name_pattern
  )
  WHERE row_number = 1
),
ranked AS (
  SELECT
    active_daily_metrics.date AS date,
    active_daily_metrics.provider_id AS provider_id,
    active_daily_metrics.user_id AS user_id,
    active_daily_metrics.hrv AS hrv,
    active_daily_metrics.spo2_avg AS spo2_avg,
    active_daily_metrics.respiratory_rate_avg AS respiratory_rate_avg,
    active_daily_metrics.steps AS steps,
    active_daily_metrics.active_energy_kcal AS active_energy_kcal,
    active_daily_metrics.basal_energy_kcal AS basal_energy_kcal,
    active_daily_metrics.distance_km AS distance_km,
    active_daily_metrics.flights_climbed AS flights_climbed,
    active_daily_metrics.exercise_minutes AS exercise_minutes,
    active_daily_metrics.walking_speed AS walking_speed,
    active_daily_metrics.walking_step_length AS walking_step_length,
    active_daily_metrics.walking_double_support_pct AS walking_double_support_pct,
    active_daily_metrics.walking_asymmetry_pct AS walking_asymmetry_pct,
    active_daily_metrics.walking_steadiness AS walking_steadiness,
    active_daily_metrics.stand_hours AS stand_hours,
    active_daily_metrics.skin_temp_c AS skin_temp_c,
    coalesce(device_priority_match.recovery_priority, active_provider_priority.recovery_priority, device_priority_match.priority, active_provider_priority.priority, 100) AS recovery_priority,
    coalesce(device_priority_match.daily_activity_priority, active_provider_priority.daily_activity_priority, device_priority_match.priority, active_provider_priority.priority, 100) AS activity_priority
  FROM active_daily_metrics
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_daily_metrics.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.daily_metrics_id = active_daily_metrics.id
)
SELECT
  date,
  user_id,
  argMinIf(hrv, recovery_priority, hrv IS NOT NULL) AS hrv,
  argMinIf(spo2_avg, recovery_priority, spo2_avg IS NOT NULL) AS spo2_avg,
  argMinIf(respiratory_rate_avg, recovery_priority, respiratory_rate_avg IS NOT NULL) AS respiratory_rate_avg,
  argMinIf(skin_temp_c, recovery_priority, skin_temp_c IS NOT NULL) AS skin_temp_c,
  argMinIf(steps, activity_priority, steps IS NOT NULL) AS steps,
  argMinIf(active_energy_kcal, activity_priority, active_energy_kcal IS NOT NULL) AS active_energy_kcal,
  argMinIf(basal_energy_kcal, activity_priority, basal_energy_kcal IS NOT NULL) AS basal_energy_kcal,
  argMinIf(distance_km, activity_priority, distance_km IS NOT NULL) AS distance_km,
  argMinIf(flights_climbed, activity_priority, flights_climbed IS NOT NULL) AS flights_climbed,
  argMinIf(exercise_minutes, activity_priority, exercise_minutes IS NOT NULL) AS exercise_minutes,
  argMinIf(stand_hours, activity_priority, stand_hours IS NOT NULL) AS stand_hours,
  argMinIf(walking_speed, activity_priority, walking_speed IS NOT NULL) AS walking_speed,
  argMinIf(walking_step_length, activity_priority, walking_step_length IS NOT NULL) AS walking_step_length,
  argMinIf(walking_double_support_pct, activity_priority, walking_double_support_pct IS NOT NULL) AS walking_double_support_pct,
  argMinIf(walking_asymmetry_pct, activity_priority, walking_asymmetry_pct IS NOT NULL) AS walking_asymmetry_pct,
  argMinIf(walking_steadiness, activity_priority, walking_steadiness IS NOT NULL) AS walking_steadiness,
  arraySort(groupUniqArray(provider_id)) AS source_providers
FROM ranked
GROUP BY date, user_id`;
}

function buildDerivedRestingHeartRateReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader(
    "analytics.derived_resting_heart_rate",
    "(user_id, date)",
  )}
WITH
sleep_windows AS (
  SELECT
    user_id,
    toDate(ended_at) AS date,
    started_at,
    ended_at
  FROM analytics.v_sleep
  WHERE sleep_type IS DISTINCT FROM 'nap'
    AND ended_at IS NOT NULL
),
raw_samples AS (
  SELECT
    sleep_windows.user_id AS user_id,
    sleep_windows.date AS date,
    metric_stream.provider_id AS provider_id,
    metric_stream.scalar AS heart_rate
  FROM sleep_windows
  INNER JOIN postgres_fitness.metric_stream AS metric_stream FINAL
    ON metric_stream.user_id = sleep_windows.user_id
   AND metric_stream.channel = 'heart_rate'
   AND metric_stream.recorded_at >= sleep_windows.started_at
   AND metric_stream.recorded_at <= sleep_windows.ended_at
   AND metric_stream.scalar IS NOT NULL
   AND metric_stream._peerdb_is_deleted = 0
),
provider_counts AS (
  SELECT user_id, date, provider_id, count() AS sample_count
  FROM raw_samples
  GROUP BY user_id, date, provider_id
),
best_provider AS (
  SELECT user_id, date, provider_id
  FROM (
    SELECT
      user_id,
      date,
      provider_id,
      row_number() OVER (
        PARTITION BY user_id, date
        ORDER BY sample_count DESC, provider_id ASC
      ) AS row_number
    FROM provider_counts
  )
  WHERE row_number = 1
),
samples AS (
  SELECT
    raw_samples.user_id AS user_id,
    raw_samples.date AS date,
    raw_samples.heart_rate AS heart_rate,
    row_number() OVER (
      PARTITION BY raw_samples.user_id, raw_samples.date
      ORDER BY raw_samples.heart_rate ASC
    ) AS ascending_rank,
    count() OVER (PARTITION BY raw_samples.user_id, raw_samples.date) AS sample_count
  FROM raw_samples
  INNER JOIN best_provider
    ON best_provider.user_id = raw_samples.user_id
   AND best_provider.date = raw_samples.date
   AND best_provider.provider_id = raw_samples.provider_id
)
SELECT
  user_id,
  date,
  CAST(round(avg(heart_rate)), 'Int32') AS resting_hr
FROM samples
WHERE sample_count >= 30
  AND ascending_rank <= greatest(ceil(sample_count * 0.10), 1)
GROUP BY user_id, date`;
}

function buildProviderStatsReadModelSql(): string {
  return `${refreshableMergeTreeViewHeader("analytics.provider_stats", "(user_id, provider_id)")}
WITH
providers AS (
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.activity FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.daily_metrics FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.sleep_session FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.body_measurement FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.metric_stream FINAL
  WHERE _peerdb_is_deleted = 0
),
activity_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.activity FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
daily_metric_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.daily_metrics FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
sleep_session_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.sleep_session FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
body_measurement_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.body_measurement FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
metric_stream_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.metric_stream FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
)
SELECT
  providers.user_id AS user_id,
  providers.provider_id AS provider_id,
  coalesce(activity_counts.count, 0) AS activities,
  coalesce(daily_metric_counts.count, 0) AS daily_metrics,
  coalesce(sleep_session_counts.count, 0) AS sleep_sessions,
  coalesce(body_measurement_counts.count, 0) AS body_measurements,
  CAST(0, 'UInt64') AS food_entries,
  CAST(0, 'UInt64') AS health_events,
  coalesce(metric_stream_counts.count, 0) AS metric_stream,
  CAST(0, 'UInt64') AS nutrition_daily,
  CAST(0, 'UInt64') AS lab_panels,
  CAST(0, 'UInt64') AS lab_results,
  CAST(0, 'UInt64') AS journal_entries
FROM providers
LEFT JOIN activity_counts
  ON activity_counts.user_id = providers.user_id
 AND activity_counts.provider_id = providers.provider_id
LEFT JOIN daily_metric_counts
  ON daily_metric_counts.user_id = providers.user_id
 AND daily_metric_counts.provider_id = providers.provider_id
LEFT JOIN sleep_session_counts
  ON sleep_session_counts.user_id = providers.user_id
 AND sleep_session_counts.provider_id = providers.provider_id
LEFT JOIN body_measurement_counts
  ON body_measurement_counts.user_id = providers.user_id
 AND body_measurement_counts.provider_id = providers.provider_id
LEFT JOIN metric_stream_counts
  ON metric_stream_counts.user_id = providers.user_id
 AND metric_stream_counts.provider_id = providers.provider_id`;
}

function buildAnalyticsFitnessReadModelStatements(): string[] {
  return [
    buildActivityReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_activity",
    "SYSTEM WAIT VIEW analytics.v_activity",
    buildActivityMembersReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_activity_members",
    "SYSTEM WAIT VIEW analytics.v_activity_members",
    buildSleepReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_sleep",
    "SYSTEM WAIT VIEW analytics.v_sleep",
    buildBodyMeasurementReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_body_measurement",
    "SYSTEM WAIT VIEW analytics.v_body_measurement",
    buildDailyMetricsReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.v_daily_metrics",
    "SYSTEM WAIT VIEW analytics.v_daily_metrics",
    buildDerivedRestingHeartRateReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.derived_resting_heart_rate",
    "SYSTEM WAIT VIEW analytics.derived_resting_heart_rate",
    buildProviderStatsReadModelSql(),
    "SYSTEM REFRESH VIEW analytics.provider_stats",
    "SYSTEM WAIT VIEW analytics.provider_stats",
  ];
}

export function parsePostgresConnectionForClickHouse(
  connectionString: string,
): ClickHousePostgresConnection {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(
      "DATABASE_URL must include a database name for ClickHouse Postgres replication",
    );
  }

  const host = normalizePostgresHostForClickHouse(url.hostname);
  const port = url.port || "5432";

  return {
    hostAndPort: `${host}:${port}`,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function buildClickHouseBootstrapStatements(postgresConnectionString: string): string[] {
  return buildClickHouseBootstrapStatementsForNativeMetricStream(postgresConnectionString);
}

function buildClickHouseBootstrapStatementsForNativeMetricStream(
  postgresConnectionString: string,
): string[] {
  void postgresConnectionString;
  const metricStreamStatements = [
    "CREATE DATABASE IF NOT EXISTS postgres_fitness",
    `CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream (
  id UUID,
  activity_id Nullable(UUID),
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  channel String,
  provider_id String,
  scalar Nullable(Float32),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, activity_id, channel, recorded_at, id)")}`,
    ...buildPostgresFitnessRawTableStatements(),
  ];

  return [
    "CREATE DATABASE IF NOT EXISTS analytics",
    ...metricStreamStatements,
    ...buildAnalyticsFitnessReadModelStatements(),
    `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor
REFRESH EVERY 1 MINUTE
ENGINE = MergeTree
ORDER BY (user_id, activity_id, channel, recorded_at)
SETTINGS allow_nullable_key = 1
AS
WITH
activity_members AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    member_activity_id
  FROM analytics.v_activity_members
),
linked_best_source AS (
  SELECT
    best_source.activity_id AS activity_id,
    best_source.channel AS channel,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      activity_members.activity_id AS activity_id,
      metric_stream.metric_channel AS channel,
      metric_stream.metric_provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY activity_members.activity_id, metric_stream.metric_channel
        ORDER BY count() DESC, metric_stream.metric_provider_id ASC
      ) AS row_number
    FROM (
      SELECT
        activity_id AS metric_activity_id,
        channel AS metric_channel,
        provider_id AS metric_provider_id,
        scalar AS metric_scalar
      FROM postgres_fitness.metric_stream FINAL
      WHERE _peerdb_is_deleted = 0
    ) AS metric_stream
    INNER JOIN activity_members
      ON metric_stream.metric_activity_id = activity_members.member_activity_id
    WHERE metric_stream.metric_activity_id IS NOT NULL
      AND metric_stream.metric_scalar IS NOT NULL
    GROUP BY activity_members.activity_id, metric_stream.metric_channel, metric_stream.metric_provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
),
linked_sample_bounds AS (
  SELECT
    activity_members.activity_id AS activity_id,
    max(metric_stream.metric_recorded_at) AS last_linked_sample_at
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      recorded_at AS metric_recorded_at
    FROM postgres_fitness.metric_stream FINAL
    WHERE _peerdb_is_deleted = 0
  ) AS metric_stream
  INNER JOIN activity_members
    ON metric_stream.metric_activity_id = activity_members.member_activity_id
  WHERE metric_stream.metric_activity_id IS NOT NULL
  GROUP BY activity_members.activity_id
),
fallback_windows AS (
  SELECT
    activity.id AS activity_id,
    activity.user_id AS user_id,
    activity.started_at AS started_at,
    coalesce(activity.ended_at, linked_sample_bounds.last_linked_sample_at) AS fallback_ended_at
  FROM analytics.v_activity AS activity
  LEFT JOIN linked_sample_bounds
    ON linked_sample_bounds.activity_id = activity.id
),
ambient_best_source AS (
  SELECT
    best_source.activity_id AS activity_id,
    best_source.channel AS channel,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      fallback_windows.activity_id AS activity_id,
      metric_stream.metric_channel AS channel,
      metric_stream.metric_provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY fallback_windows.activity_id, metric_stream.metric_channel
        ORDER BY count() DESC, metric_stream.metric_provider_id ASC
      ) AS row_number
    FROM (
      SELECT
        activity_id AS metric_activity_id,
        user_id AS metric_user_id,
        recorded_at AS metric_recorded_at,
        channel AS metric_channel,
        provider_id AS metric_provider_id,
        scalar AS metric_scalar
      FROM postgres_fitness.metric_stream FINAL
      WHERE _peerdb_is_deleted = 0
    ) AS metric_stream
    INNER JOIN fallback_windows
      ON fallback_windows.user_id = metric_stream.metric_user_id
    LEFT JOIN linked_best_source
      ON linked_best_source.activity_id = fallback_windows.activity_id
     AND linked_best_source.channel = metric_stream.metric_channel
    WHERE metric_stream.metric_activity_id IS NULL
      AND fallback_windows.fallback_ended_at IS NOT NULL
      AND metric_stream.metric_recorded_at >= fallback_windows.started_at
      AND metric_stream.metric_recorded_at <= fallback_windows.fallback_ended_at
      AND metric_stream.metric_scalar IS NOT NULL
      AND linked_best_source.activity_id IS NULL
    GROUP BY fallback_windows.activity_id, metric_stream.metric_channel, metric_stream.metric_provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
),
linked_samples AS (
  SELECT
    activity_members.activity_id AS activity_id,
    activity_members.user_id AS user_id,
    metric_stream.metric_recorded_at AS recorded_at,
    metric_stream.metric_channel AS channel,
    max(metric_stream.metric_scalar) AS scalar
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      recorded_at AS metric_recorded_at,
      channel AS metric_channel,
      provider_id AS metric_provider_id,
      scalar AS metric_scalar
    FROM postgres_fitness.metric_stream FINAL
    WHERE _peerdb_is_deleted = 0
  ) AS metric_stream
  INNER JOIN activity_members
    ON metric_stream.metric_activity_id = activity_members.member_activity_id
  INNER JOIN linked_best_source
    ON linked_best_source.activity_id = activity_members.activity_id
   AND linked_best_source.channel = metric_stream.metric_channel
   AND linked_best_source.provider_id = metric_stream.metric_provider_id
  WHERE metric_stream.metric_activity_id IS NOT NULL
    AND metric_stream.metric_scalar IS NOT NULL
  GROUP BY activity_members.activity_id, activity_members.user_id, metric_stream.metric_recorded_at, metric_stream.metric_channel
),
ambient_samples AS (
  SELECT
    fallback_windows.activity_id AS activity_id,
    fallback_windows.user_id AS user_id,
    metric_stream.metric_recorded_at AS recorded_at,
    metric_stream.metric_channel AS channel,
    max(metric_stream.metric_scalar) AS scalar
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      user_id AS metric_user_id,
      recorded_at AS metric_recorded_at,
      channel AS metric_channel,
      provider_id AS metric_provider_id,
      scalar AS metric_scalar
    FROM postgres_fitness.metric_stream FINAL
    WHERE _peerdb_is_deleted = 0
  ) AS metric_stream
  INNER JOIN fallback_windows
    ON fallback_windows.user_id = metric_stream.metric_user_id
  INNER JOIN ambient_best_source
    ON ambient_best_source.activity_id = fallback_windows.activity_id
   AND ambient_best_source.channel = metric_stream.metric_channel
   AND ambient_best_source.provider_id = metric_stream.metric_provider_id
  WHERE metric_stream.metric_activity_id IS NULL
    AND fallback_windows.fallback_ended_at IS NOT NULL
    AND metric_stream.metric_recorded_at >= fallback_windows.started_at
    AND metric_stream.metric_recorded_at <= fallback_windows.fallback_ended_at
    AND metric_stream.metric_scalar IS NOT NULL
  GROUP BY fallback_windows.activity_id, fallback_windows.user_id, metric_stream.metric_recorded_at, metric_stream.metric_channel
)
SELECT
  linked_samples.activity_id AS activity_id,
  linked_samples.user_id AS user_id,
  linked_samples.recorded_at AS recorded_at,
  linked_samples.channel AS channel,
  linked_samples.scalar AS scalar
FROM linked_samples
UNION ALL
SELECT
  ambient_samples.activity_id AS activity_id,
  ambient_samples.user_id AS user_id,
  ambient_samples.recorded_at AS recorded_at,
  ambient_samples.channel AS channel,
  ambient_samples.scalar AS scalar
FROM ambient_samples`,
    "SYSTEM REFRESH VIEW analytics.deduped_sensor",
    "SYSTEM WAIT VIEW analytics.deduped_sensor",
    `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary
REFRESH EVERY 1 MINUTE OFFSET 10 SECOND
ENGINE = MergeTree
ORDER BY (user_id, started_at, activity_id)
SETTINGS allow_nullable_key = 1
AS
WITH
deduped_samples AS (
  SELECT activity_id, user_id, recorded_at, channel, scalar
  FROM analytics.deduped_sensor
),
activity_bounds AS (
  SELECT
    id AS activity_id,
    user_id,
    activity_type,
    name,
    started_at,
    ended_at
  FROM analytics.v_activity
),
altitude_deltas AS (
  SELECT
    activity_id,
    scalar AS altitude,
    lagInFrame(scalar) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_altitude
  FROM deduped_samples
  WHERE channel = 'altitude'
),
elevation_per_activity AS (
  SELECT
    activity_id,
    CAST(sum(if(altitude - prev_altitude > 0, altitude - prev_altitude, 0)), 'Nullable(Float64)') AS elevation_gain_m,
    CAST(sum(if(altitude - prev_altitude < 0, abs(altitude - prev_altitude), 0)), 'Nullable(Float64)') AS elevation_loss_m
  FROM altitude_deltas
  WHERE prev_altitude IS NOT NULL
  GROUP BY activity_id
),
gps_points AS (
  SELECT
    lat_samples.activity_id AS activity_id,
    lat_samples.recorded_at AS recorded_at,
    lat_samples.scalar AS lat,
    lng_samples.scalar AS lng
  FROM deduped_samples AS lat_samples
  INNER JOIN deduped_samples AS lng_samples
    ON lat_samples.activity_id = lng_samples.activity_id
   AND lat_samples.recorded_at = lng_samples.recorded_at
   AND lng_samples.channel = 'lng'
  WHERE lat_samples.channel = 'lat'
),
gps_deltas AS (
  SELECT
    activity_id,
    lat,
    lng,
    lagInFrame(lat) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_lat,
    lagInFrame(lng) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_lng
  FROM gps_points
),
distance_per_activity AS (
  SELECT
    activity_id,
    CAST(sum(
      2 * 6371000 * asin(sqrt(
        pow(sin(radians(lat - prev_lat) / 2), 2)
        + cos(radians(prev_lat)) * cos(radians(lat))
        * pow(sin(radians(lng - prev_lng) / 2), 2)
      ))
    ), 'Nullable(Float64)') AS total_distance
  FROM gps_deltas
  WHERE prev_lat IS NOT NULL
  GROUP BY activity_id
),
channel_aggs AS (
  SELECT
    activity_id,
    user_id,
    CAST(avgIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS avg_hr,
    CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS max_hr,
    CAST(minIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS min_hr,
    CAST(avgIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Float64)') AS avg_power,
    CAST(maxIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Int16)') AS max_power,
    CAST(avgIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS avg_speed,
    CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS max_speed,
    CAST(avgIf(scalar, channel = 'cadence' AND scalar > 0), 'Nullable(Float64)') AS avg_cadence,
    CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS max_altitude,
    CAST(minIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS min_altitude,
    CAST(avgIf(scalar, channel = 'left_right_balance'), 'Nullable(Float64)') AS avg_left_balance,
    CAST(avgIf(scalar, channel = 'left_torque_effectiveness'), 'Nullable(Float64)') AS avg_left_torque_eff,
    CAST(avgIf(scalar, channel = 'right_torque_effectiveness'), 'Nullable(Float64)') AS avg_right_torque_eff,
    CAST(avgIf(scalar, channel = 'left_pedal_smoothness'), 'Nullable(Float64)') AS avg_left_pedal_smooth,
    CAST(avgIf(scalar, channel = 'right_pedal_smoothness'), 'Nullable(Float64)') AS avg_right_pedal_smooth,
    CAST(avgIf(scalar, channel = 'stance_time'), 'Nullable(Float64)') AS avg_stance_time,
    CAST(avgIf(scalar, channel = 'vertical_oscillation'), 'Nullable(Float64)') AS avg_vertical_osc,
    CAST(avgIf(scalar, channel = 'ground_contact_time'), 'Nullable(Float64)') AS avg_ground_contact_time,
    CAST(avgIf(scalar, channel = 'stride_length'), 'Nullable(Float64)') AS avg_stride_length,
    count() AS sample_count,
    countIf(channel = 'heart_rate') AS hr_sample_count,
    countIf(channel = 'power' AND scalar > 0) AS power_sample_count,
    min(recorded_at) AS first_sample_at,
    max(recorded_at) AS last_sample_at
  FROM deduped_samples
  GROUP BY activity_id, user_id
)
SELECT
  activity_bounds.activity_id AS activity_id,
  activity_bounds.user_id AS user_id,
  activity_bounds.activity_type AS activity_type,
  activity_bounds.name AS name,
  activity_bounds.started_at AS started_at,
  activity_bounds.ended_at AS ended_at,
  channel_aggs.avg_hr AS avg_hr,
  channel_aggs.max_hr AS max_hr,
  channel_aggs.min_hr AS min_hr,
  channel_aggs.avg_power AS avg_power,
  channel_aggs.max_power AS max_power,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     NULL,
     channel_aggs.avg_speed) AS avg_speed,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     NULL,
     channel_aggs.max_speed) AS max_speed,
  channel_aggs.avg_cadence AS avg_cadence,
  if(channel_aggs.max_altitude IS NOT NULL AND channel_aggs.min_altitude IS NOT NULL,
     channel_aggs.max_altitude - channel_aggs.min_altitude,
     NULL) AS elevation_gain_legacy,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     CAST(0, 'Nullable(Float64)'),
     coalesce(distance_per_activity.total_distance, CAST(0, 'Nullable(Float64)'))) AS total_distance,
  channel_aggs.avg_left_balance AS avg_left_balance,
  channel_aggs.avg_left_torque_eff AS avg_left_torque_eff,
  channel_aggs.avg_right_torque_eff AS avg_right_torque_eff,
  channel_aggs.avg_left_pedal_smooth AS avg_left_pedal_smooth,
  channel_aggs.avg_right_pedal_smooth AS avg_right_pedal_smooth,
  coalesce(elevation_per_activity.elevation_gain_m, CAST(0, 'Nullable(Float64)')) AS elevation_gain_m,
  coalesce(elevation_per_activity.elevation_loss_m, CAST(0, 'Nullable(Float64)')) AS elevation_loss_m,
  channel_aggs.avg_stance_time AS avg_stance_time,
  channel_aggs.avg_vertical_osc AS avg_vertical_osc,
  channel_aggs.avg_ground_contact_time AS avg_ground_contact_time,
  channel_aggs.avg_stride_length AS avg_stride_length,
  channel_aggs.sample_count AS sample_count,
  channel_aggs.hr_sample_count AS hr_sample_count,
  channel_aggs.power_sample_count AS power_sample_count,
  channel_aggs.first_sample_at AS first_sample_at,
  channel_aggs.last_sample_at AS last_sample_at
FROM activity_bounds
LEFT JOIN channel_aggs
  ON channel_aggs.activity_id = activity_bounds.activity_id
LEFT JOIN elevation_per_activity
  ON elevation_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN distance_per_activity
  ON distance_per_activity.activity_id = activity_bounds.activity_id`,
    "SYSTEM REFRESH VIEW analytics.activity_summary",
    "SYSTEM WAIT VIEW analytics.activity_summary",
  ];
}

export function createClickHouseClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ClickHouseClientOptions = {},
): ClickHouseClient {
  const url = env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }
  return createClient({
    url,
    request_timeout: options.requestTimeoutMs ?? CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS,
  });
}

export async function bootstrapClickHouseFromEnv(client: ClickHouseCommandClient): Promise<void> {
  await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  await waitForClickHouseTable(client, "analytics", "deduped_sensor");
  await waitForClickHouseTable(client, "analytics", "activity_summary");
  await smokeTestClickHouseTable(client, "postgres_fitness.metric_stream");
  await smokeTestClickHouseTable(client, "analytics.deduped_sensor");
  await smokeTestClickHouseTable(client, "analytics.activity_summary");
}

async function smokeTestClickHouseTable(
  client: ClickHouseCommandClient,
  tableName: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse smoke verification requires a query-capable client");
  }
  const result = await client.query({
    query: `SELECT count() AS smoke_count FROM ${tableName} LIMIT 1`,
    format: "JSONEachRow",
  });
  await result.json();
}

export async function waitForClickHouseTable(
  client: ClickHouseCommandClient,
  database: string,
  table: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse table verification requires a query-capable client");
  }

  for (let attempt = 0; attempt < CLICKHOUSE_TABLE_WAIT_ATTEMPTS; attempt += 1) {
    const result = await client.query<TableCountRow>({
      query: `SELECT count() AS table_count FROM system.tables WHERE database = ${clickHouseStringLiteral(
        database,
      )} AND name = ${clickHouseStringLiteral(table)}`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    if (Number(rows[0]?.table_count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ClickHouse table ${database}.${table}`);
}
