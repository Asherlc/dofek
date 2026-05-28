import {
  peerDbMetadataColumnDefinitions,
  replacingMergeTreeTable,
  standardViewHeader,
} from "./clickhouse-sql-helpers.ts";

const bodyMeasurementChannels = [
  "body_weight",
  "body_fat_percentage",
  "muscle_mass",
  "bone_mass",
  "body_water_percentage",
  "body_mass_index",
  "height",
  "waist_circumference",
  "systolic_blood_pressure",
  "diastolic_blood_pressure",
  "heart_pulse",
  "body_temperature",
];

function bodyMeasurementChannelListSql(): string {
  return bodyMeasurementChannels.map((channel) => `'${channel}'`).join(",\n      ");
}

function buildBodyMeasurementSampleProjectionTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.body_measurement_sample (
  id UUID,
  provider_id String,
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  channel String,
  external_id Nullable(String),
  device_id Nullable(String),
  source_type Nullable(String),
  scalar Nullable(Float32),
${peerDbMetadataColumnDefinitions}
)
${replacingMergeTreeTable("(user_id, recorded_at, channel, provider_id, id)")}`;
}

function buildBodyMeasurementSampleProjectionIngestSql(): string {
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.body_measurement_sample_ingest TO analytics.body_measurement_sample
AS
SELECT
  id,
  provider_id,
  user_id,
  recorded_at,
  channel,
  external_id,
  device_id,
  source_type,
  scalar,
  _peerdb_synced_at,
  _peerdb_is_deleted,
  _peerdb_version
FROM postgres_fitness.metric_stream
WHERE channel IN (
      ${bodyMeasurementChannelListSql()}
    )`;
}

function buildBodyMeasurementSampleProjectionBackfillSql(): string {
  return `INSERT INTO analytics.body_measurement_sample (
  id,
  provider_id,
  user_id,
  recorded_at,
  channel,
  external_id,
  device_id,
  source_type,
  scalar,
  _peerdb_synced_at,
  _peerdb_is_deleted,
  _peerdb_version
)
SELECT
  id,
  provider_id,
  user_id,
  recorded_at,
  channel,
  external_id,
  device_id,
  source_type,
  scalar,
  _peerdb_synced_at,
  _peerdb_is_deleted,
  _peerdb_version
FROM postgres_fitness.metric_stream
WHERE channel IN (
      ${bodyMeasurementChannelListSql()}
    )`;
}

export function buildBodyMeasurementSampleProjectionStatements(): string[] {
  return [
    buildBodyMeasurementSampleProjectionTableSql(),
    buildBodyMeasurementSampleProjectionIngestSql(),
  ];
}

export function buildBodyMeasurementSampleProjectionMigrationStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.body_measurement_sample_ingest",
    ...buildBodyMeasurementSampleProjectionStatements(),
    buildBodyMeasurementSampleProjectionBackfillSql(),
  ];
}

function buildActivityReadModelSql(): string {
  return `${standardViewHeader("analytics.v_activity")}
WITH RECURSIVE
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
graph_edges AS (
  SELECT id1 AS from_id, id2 AS to_id
  FROM pairs
  UNION ALL
  SELECT id2 AS from_id, id1 AS to_id
  FROM pairs
),
connected_components AS (
  SELECT
    id AS activity_id,
    id AS connected_activity_id,
    [toString(id)] AS visited_activity_ids
  FROM ranked
  UNION ALL
  SELECT
    connected_components.activity_id AS activity_id,
    graph_edges.to_id AS connected_activity_id,
    arrayConcat(connected_components.visited_activity_ids, [toString(graph_edges.to_id)]) AS visited_activity_ids
  FROM connected_components
  INNER JOIN graph_edges
    ON graph_edges.from_id = connected_components.connected_activity_id
  WHERE NOT has(connected_components.visited_activity_ids, toString(graph_edges.to_id))
),
final_groups AS (
  SELECT activity_id, min(toString(connected_activity_id)) AS group_id
  FROM connected_components
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
  return `${standardViewHeader("analytics.v_activity_members")}
SELECT
  id AS activity_id,
  user_id,
  started_at,
  ended_at,
  arrayJoin(member_activity_ids) AS member_activity_id
FROM analytics.v_activity`;
}

function buildSleepReadModelSql(): string {
  return `${standardViewHeader("analytics.v_sleep")}
WITH RECURSIVE
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
    active_sleep.sleep_need_total_minutes AS sleep_need_total_minutes,
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
graph_edges AS (
  SELECT id1 AS from_id, id2 AS to_id
  FROM pairs
  UNION ALL
  SELECT id2 AS from_id, id1 AS to_id
  FROM pairs
),
connected_components AS (
  SELECT
    id AS sleep_id,
    id AS connected_sleep_id,
    [toString(id)] AS visited_sleep_ids
  FROM ranked
  UNION ALL
  SELECT
    connected_components.sleep_id AS sleep_id,
    graph_edges.to_id AS connected_sleep_id,
    arrayConcat(connected_components.visited_sleep_ids, [toString(graph_edges.to_id)]) AS visited_sleep_ids
  FROM connected_components
  INNER JOIN graph_edges
    ON graph_edges.from_id = connected_components.connected_sleep_id
  WHERE NOT has(connected_components.visited_sleep_ids, toString(graph_edges.to_id))
),
final_groups AS (
  SELECT sleep_id, min(toString(connected_sleep_id)) AS group_id
  FROM connected_components
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
      ranked.sleep_need_total_minutes AS sleep_need_total_minutes,
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
  best.sleep_need_total_minutes AS sleep_need_total_minutes,
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
  best.sleep_need_total_minutes,
  best.is_nap,
  best.source_name`;
}

function buildBodyMeasurementReadModelSql(): string {
  return `${standardViewHeader("analytics.v_body_measurement")}
WITH RECURSIVE
body_measurement_samples AS (
  SELECT
    id,
    provider_id,
    user_id,
    recorded_at,
    _peerdb_synced_at AS created_at,
    device_id,
    channel,
    scalar,
    ifNull(
      external_id,
      concat(provider_id, ':', toString(user_id), ':', toString(recorded_at), ':', ifNull(device_id, ''))
    ) AS measurement_key
  FROM analytics.body_measurement_sample FINAL
  WHERE _peerdb_is_deleted = 0
    AND channel IN (
      ${bodyMeasurementChannelListSql()}
    )
),
active_body AS (
  SELECT
    min(id) AS id,
    provider_id,
    user_id,
    measurement_key AS external_id,
    recorded_at,
    min(created_at) AS created_at,
    device_id AS source_name,
    maxIf(scalar, channel = 'body_weight') AS weight_kg,
    maxIf(scalar, channel = 'body_fat_percentage') AS body_fat_pct,
    maxIf(scalar, channel = 'muscle_mass') AS muscle_mass_kg,
    maxIf(scalar, channel = 'bone_mass') AS bone_mass_kg,
    maxIf(scalar, channel = 'body_water_percentage') AS water_pct,
    maxIf(scalar, channel = 'body_mass_index') AS bmi,
    maxIf(scalar, channel = 'height') AS height_cm,
    maxIf(scalar, channel = 'waist_circumference') AS waist_circumference_cm,
    maxIf(scalar, channel = 'systolic_blood_pressure') AS systolic_bp,
    maxIf(scalar, channel = 'diastolic_blood_pressure') AS diastolic_bp,
    maxIf(scalar, channel = 'heart_pulse') AS heart_pulse,
    maxIf(scalar, channel = 'body_temperature') AS temperature_c
  FROM body_measurement_samples
  GROUP BY
    provider_id,
    user_id,
    measurement_key,
    recorded_at,
    device_id
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
    active_body.external_id AS external_id,
    active_body.recorded_at AS recorded_at,
    active_body.created_at AS created_at,
    active_body.weight_kg AS weight_kg,
    active_body.body_fat_pct AS body_fat_pct,
    active_body.muscle_mass_kg AS muscle_mass_kg,
    active_body.bone_mass_kg AS bone_mass_kg,
    active_body.water_pct AS water_pct,
    active_body.bmi AS bmi,
    active_body.height_cm AS height_cm,
    active_body.waist_circumference_cm AS waist_circumference_cm,
    active_body.systolic_bp AS systolic_bp,
    active_body.diastolic_bp AS diastolic_bp,
    active_body.heart_pulse AS heart_pulse,
    active_body.temperature_c AS temperature_c,
    active_body.source_name AS source_name,
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
graph_edges AS (
  SELECT id1 AS from_id, id2 AS to_id
  FROM pairs
  UNION ALL
  SELECT id2 AS from_id, id1 AS to_id
  FROM pairs
),
connected_components AS (
  SELECT
    id AS measurement_id,
    id AS connected_measurement_id,
    [toString(id)] AS visited_measurement_ids
  FROM ranked
  UNION ALL
  SELECT
    connected_components.measurement_id AS measurement_id,
    graph_edges.to_id AS connected_measurement_id,
    arrayConcat(connected_components.visited_measurement_ids, [toString(graph_edges.to_id)]) AS visited_measurement_ids
  FROM connected_components
  INNER JOIN graph_edges
    ON graph_edges.from_id = connected_components.connected_measurement_id
  WHERE NOT has(connected_components.visited_measurement_ids, toString(graph_edges.to_id))
),
final_groups AS (
  SELECT measurement_id, min(toString(connected_measurement_id)) AS group_id
  FROM connected_components
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
      ranked.external_id AS external_id,
      ranked.recorded_at AS recorded_at,
      ranked.created_at AS created_at,
      ranked.source_name AS source_name,
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
  best.external_id AS external_id,
  best.recorded_at AS recorded_at,
  best.created_at AS created_at,
  argMinIf(ranked.weight_kg, ranked.priority, ranked.weight_kg IS NOT NULL) AS weight_kg,
  argMinIf(ranked.body_fat_pct, ranked.priority, ranked.body_fat_pct IS NOT NULL) AS body_fat_pct,
  argMinIf(ranked.muscle_mass_kg, ranked.priority, ranked.muscle_mass_kg IS NOT NULL) AS muscle_mass_kg,
  argMinIf(ranked.bone_mass_kg, ranked.priority, ranked.bone_mass_kg IS NOT NULL) AS bone_mass_kg,
  argMinIf(ranked.water_pct, ranked.priority, ranked.water_pct IS NOT NULL) AS water_pct,
  argMinIf(ranked.bmi, ranked.priority, ranked.bmi IS NOT NULL) AS bmi,
  argMinIf(ranked.height_cm, ranked.priority, ranked.height_cm IS NOT NULL) AS height_cm,
  argMinIf(ranked.waist_circumference_cm, ranked.priority, ranked.waist_circumference_cm IS NOT NULL) AS waist_circumference_cm,
  argMinIf(ranked.systolic_bp, ranked.priority, ranked.systolic_bp IS NOT NULL) AS systolic_bp,
  argMinIf(ranked.diastolic_bp, ranked.priority, ranked.diastolic_bp IS NOT NULL) AS diastolic_bp,
  argMinIf(ranked.heart_pulse, ranked.priority, ranked.heart_pulse IS NOT NULL) AS heart_pulse,
  argMinIf(ranked.temperature_c, ranked.priority, ranked.temperature_c IS NOT NULL) AS temperature_c,
  best.source_name AS source_name,
  arraySort(groupUniqArray(ranked.provider_id)) AS source_providers
FROM best
INNER JOIN final_groups
  ON final_groups.group_id = best.group_id
INNER JOIN ranked
  ON ranked.id = final_groups.measurement_id
GROUP BY best.id, best.provider_id, best.user_id, best.external_id, best.recorded_at, best.created_at, best.source_name`;
}

function buildDailyMetricsReadModelSql(): string {
  return `${standardViewHeader("analytics.v_daily_metrics")}
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

function buildProviderStatsReadModelSql(): string {
  return `${standardViewHeader("analytics.provider_stats")}
WITH
providers AS (
  SELECT DISTINCT user_id, id AS provider_id
  FROM postgres_fitness.provider FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
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
  FROM postgres_fitness.metric_stream FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.food_entry FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.health_event FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.lab_panel FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.lab_result FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.journal_entry FINAL
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
  SELECT
    user_id,
    provider_id,
    uniqExact(ifNull(
      external_id,
      concat(provider_id, ':', toString(user_id), ':', toString(recorded_at), ':', ifNull(device_id, ''))
    )) AS count
  FROM analytics.body_measurement_sample FINAL
  WHERE _peerdb_is_deleted = 0
    AND channel IN (
      ${bodyMeasurementChannelListSql()}
    )
  GROUP BY user_id, provider_id
),
metric_stream_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.metric_stream FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
food_entry_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.food_entry FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
health_event_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.health_event FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
nutrition_daily_counts AS (
  SELECT user_id, provider_id, uniqExact(date) AS count
  FROM postgres_fitness.food_entry FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
lab_panel_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.lab_panel FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
lab_result_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.lab_result FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
journal_entry_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.journal_entry FINAL
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
  coalesce(food_entry_counts.count, 0) AS food_entries,
  coalesce(health_event_counts.count, 0) AS health_events,
  coalesce(metric_stream_counts.count, 0) AS metric_stream,
  coalesce(nutrition_daily_counts.count, 0) AS nutrition_daily,
  coalesce(lab_panel_counts.count, 0) AS lab_panels,
  coalesce(lab_result_counts.count, 0) AS lab_results,
  coalesce(journal_entry_counts.count, 0) AS journal_entries
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
 AND metric_stream_counts.provider_id = providers.provider_id
LEFT JOIN food_entry_counts
  ON food_entry_counts.user_id = providers.user_id
 AND food_entry_counts.provider_id = providers.provider_id
LEFT JOIN health_event_counts
  ON health_event_counts.user_id = providers.user_id
 AND health_event_counts.provider_id = providers.provider_id
LEFT JOIN nutrition_daily_counts
  ON nutrition_daily_counts.user_id = providers.user_id
 AND nutrition_daily_counts.provider_id = providers.provider_id
LEFT JOIN lab_panel_counts
  ON lab_panel_counts.user_id = providers.user_id
 AND lab_panel_counts.provider_id = providers.provider_id
LEFT JOIN lab_result_counts
  ON lab_result_counts.user_id = providers.user_id
 AND lab_result_counts.provider_id = providers.provider_id
LEFT JOIN journal_entry_counts
  ON journal_entry_counts.user_id = providers.user_id
 AND journal_entry_counts.provider_id = providers.provider_id`;
}

export function buildProviderStatsCreateReadModelStatements(): string[] {
  return [buildProviderStatsReadModelSql()];
}

export function buildProviderStatsReadModelStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.provider_stats",
    "DROP TABLE IF EXISTS analytics.provider_stats",
    ...buildProviderStatsCreateReadModelStatements(),
  ];
}

export function buildAnalyticsFitnessReadModelStatements(): string[] {
  return [
    buildActivityReadModelSql(),
    buildActivityMembersReadModelSql(),
    buildSleepReadModelSql(),
    buildBodyMeasurementReadModelSql(),
    buildDailyMetricsReadModelSql(),
    ...buildProviderStatsCreateReadModelStatements(),
  ];
}

export function buildSleepReadModelStatements(): string[] {
  return ["DROP VIEW IF EXISTS analytics.v_sleep", buildSleepReadModelSql()];
}

export function buildBodyMeasurementReadModelStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.v_body_measurement",
    "DROP TABLE IF EXISTS analytics.v_body_measurement",
    buildBodyMeasurementReadModelSql(),
  ];
}
