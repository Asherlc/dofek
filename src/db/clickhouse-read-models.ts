import { METRIC_STREAM_TABLE } from "../metric-stream/clickhouse-table.ts";
import { buildProviderStatsTableSql } from "./clickhouse-provider-stats.ts";
import {
  peerDbMetadataColumnDefinitions,
  replacingMergeTreeTable,
  standardViewHeader,
} from "./clickhouse-sql-helpers.ts";

export const bodyMeasurementChannels = [
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
] as const;

export function bodyMeasurementChannelListSql(): string {
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
  ingested_at AS _peerdb_synced_at,
  is_deleted AS _peerdb_is_deleted,
  version AS _peerdb_version
FROM ${METRIC_STREAM_TABLE}
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
  ingested_at AS _peerdb_synced_at,
  is_deleted AS _peerdb_is_deleted,
  version AS _peerdb_version
FROM ${METRIC_STREAM_TABLE}
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
    AND provider_absent_at IS NULL
    AND deleted_at IS NULL
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
    active_activity.canonical_type AS canonical_type,
    active_activity.provider_type AS provider_type,
    active_activity.modality AS modality,
    active_activity.started_at AS started_at,
    active_activity.ended_at AS ended_at,
    active_activity.source_name AS source_name,
    active_activity.name AS name,
    active_activity.notes AS notes,
    active_activity.timezone AS timezone,
    active_activity.start_utc_offset_minutes AS start_utc_offset_minutes,
    active_activity.end_utc_offset_minutes AS end_utc_offset_minutes,
    active_activity.local_time_source AS local_time_source,
    active_activity.raw AS raw,
    coalesce(device_priority_match.priority, active_provider_priority.priority, 100) AS priority
  FROM active_activity
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_activity.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.activity_id = active_activity.id
),
tombstoned AS (
  SELECT
    activity.id AS id,
    activity.user_id AS user_id,
    activity.provider_id AS provider_id,
    activity.canonical_type AS canonical_type,
    activity.external_id AS external_id,
    activity.started_at AS started_at,
    activity.ended_at AS ended_at,
    activity.provider_absent_at AS provider_absent_at
  FROM postgres_fitness.activity FINAL
  WHERE _peerdb_is_deleted = 0
    AND provider_absent_at IS NOT NULL
    AND deleted_at IS NULL
    AND external_id IS NOT NULL
    AND external_id != ''
),
clusterable AS (
  SELECT
    ranked.id AS id,
    ranked.user_id AS user_id,
    ranked.provider_id AS provider_id,
    ranked.canonical_type AS canonical_type,
    ranked.started_at AS started_at,
    coalesce(ranked.ended_at, ranked.started_at + INTERVAL 1 HOUR) AS ended_at
  FROM ranked
  UNION ALL
  SELECT
    tombstoned.id AS id,
    tombstoned.user_id AS user_id,
    tombstoned.provider_id AS provider_id,
    tombstoned.canonical_type AS canonical_type,
    tombstoned.started_at AS started_at,
    coalesce(tombstoned.ended_at, tombstoned.started_at + INTERVAL 1 HOUR) AS ended_at
  FROM tombstoned
),
pairs AS (
  SELECT
    left_activity.id AS id1,
    right_activity.id AS id2
  FROM clusterable AS left_activity
  INNER JOIN clusterable AS right_activity
    ON left_activity.user_id = right_activity.user_id
   AND toString(left_activity.id) < toString(right_activity.id)
   AND (
     dateDiff(
        'second',
        greatest(left_activity.started_at, right_activity.started_at),
        least(left_activity.ended_at, right_activity.ended_at)
      ) / nullIf(dateDiff(
        'second',
        least(left_activity.started_at, right_activity.started_at),
        greatest(left_activity.ended_at, right_activity.ended_at)
      ), 0) > 0.8
      OR (
        left_activity.provider_id != right_activity.provider_id
        AND left_activity.canonical_type = right_activity.canonical_type
        AND dateDiff(
          'second',
          greatest(left_activity.started_at, right_activity.started_at),
          least(left_activity.ended_at, right_activity.ended_at)
        ) / nullIf(least(
          dateDiff('second', left_activity.started_at, left_activity.ended_at),
          dateDiff('second', right_activity.started_at, right_activity.ended_at)
        ), 0) > 0.8
      )
    )
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
  FROM clusterable
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
absent_source_links AS (
  SELECT
    final_groups.group_id AS group_id,
    groupArrayIf(
      map(
        'providerId', tombstoned.provider_id,
        'externalId', tombstoned.external_id,
        'memberActivityId', toString(tombstoned.id),
        'providerAbsentAt', toString(tombstoned.provider_absent_at)
      ),
      tombstoned.provider_id IS NOT NULL
      AND tombstoned.external_id IS NOT NULL
      AND tombstoned.external_id != ''
    ) AS absent_source_external_ids
  FROM final_groups
  INNER JOIN tombstoned
    ON tombstoned.id = final_groups.activity_id
  GROUP BY final_groups.group_id
),
tombstoned_groups AS (
  SELECT DISTINCT final_groups.group_id AS group_id
  FROM final_groups
  INNER JOIN tombstoned
    ON tombstoned.id = final_groups.activity_id
),
best AS (
  SELECT *
  FROM (
    SELECT
      final_groups.group_id AS group_id,
      ranked.id AS canonical_id,
      ranked.provider_id AS provider_id,
      ranked.user_id AS user_id,
      ranked.canonical_type AS canonical_type,
      ranked.provider_type AS provider_type,
      ranked.modality AS modality,
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
    any(best.canonical_type) AS canonical_type,
    any(best.provider_type) AS provider_type,
    any(best.modality) AS modality,
    any(best.started_at) AS started_at,
    any(best.ended_at) AS ended_at,
    any(best.source_name) AS source_name,
    argMinIf(ranked.name, ranked.priority, ranked.name IS NOT NULL) AS name,
    argMinIf(ranked.notes, ranked.priority, ranked.notes IS NOT NULL) AS notes,
    tupleElement(
      argMinIf(
        tuple(
          ranked.timezone,
          ranked.start_utc_offset_minutes,
          ranked.end_utc_offset_minutes,
          ranked.local_time_source
        ),
        tuple(ranked.priority, toString(ranked.id)),
        ranked.local_time_source != 'unknown'
      ),
      1
    ) AS timezone,
    tupleElement(
      argMinIf(
        tuple(
          ranked.timezone,
          ranked.start_utc_offset_minutes,
          ranked.end_utc_offset_minutes,
          ranked.local_time_source
        ),
        tuple(ranked.priority, toString(ranked.id)),
        ranked.local_time_source != 'unknown'
      ),
      2
    ) AS start_utc_offset_minutes,
    tupleElement(
      argMinIf(
        tuple(
          ranked.timezone,
          ranked.start_utc_offset_minutes,
          ranked.end_utc_offset_minutes,
          ranked.local_time_source
        ),
        tuple(ranked.priority, toString(ranked.id)),
        ranked.local_time_source != 'unknown'
      ),
      3
    ) AS end_utc_offset_minutes,
    tupleElement(
      argMinIf(
        tuple(
          ranked.timezone,
          ranked.start_utc_offset_minutes,
          ranked.end_utc_offset_minutes,
          ranked.local_time_source
        ),
        tuple(ranked.priority, toString(ranked.id)),
        ranked.local_time_source != 'unknown'
      ),
      4
    ) AS local_time_source,
    argMinIf(ranked.raw, ranked.priority, ranked.raw IS NOT NULL) AS raw,
    arraySort(groupUniqArrayIf(ranked.provider_id, ranked.id IS NOT NULL)) AS source_providers,
    groupArrayIf(
      map('providerId', ranked.provider_id, 'externalId', ranked.external_id),
      ranked.id IS NOT NULL
      AND ranked.external_id IS NOT NULL
      AND ranked.external_id != ''
    ) AS source_external_ids,
    coalesce(any(absent_source_links.absent_source_external_ids), []) AS absent_source_external_ids,
    groupArray(final_groups.activity_id) AS member_activity_ids
  FROM best
  INNER JOIN final_groups
    ON final_groups.group_id = best.group_id
  LEFT JOIN ranked
    ON ranked.id = final_groups.activity_id
  LEFT JOIN absent_source_links
    ON absent_source_links.group_id = best.group_id
  WHERE best.group_id NOT IN (SELECT group_id FROM tombstoned_groups)
  GROUP BY best.group_id, best.canonical_id
)
SELECT
  id,
  provider_id,
  user_id,
  id AS primary_activity_id,
  canonical_type,
  provider_type,
  modality,
  started_at,
  ended_at,
  source_name,
  name,
  notes,
  timezone,
  start_utc_offset_minutes,
  end_utc_offset_minutes,
  coalesce(nullIf(local_time_source, ''), 'unknown') AS local_time_source,
  raw,
  source_providers,
  source_external_ids,
  absent_source_external_ids,
  member_activity_ids
FROM merged`;
}

export function buildActivityReadModelRefreshStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.v_activity_members",
    "DROP VIEW IF EXISTS analytics.v_activity",
    buildActivityReadModelSql(),
    buildActivityMembersReadModelSql(),
  ];
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
    active_sleep.staging_available AS staging_available,
    active_sleep.sleep_type AS sleep_type,
    active_sleep.source_name AS source_name,
    active_sleep.timezone AS timezone,
    active_sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
    active_sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
    active_sleep.local_time_source AS local_time_source,
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
      ranked.staging_available AS staging_available,
      ranked.sleep_type AS sleep_type,
      ranked.source_name AS source_name,
      ranked.timezone AS timezone,
      ranked.start_utc_offset_minutes AS start_utc_offset_minutes,
      ranked.end_utc_offset_minutes AS end_utc_offset_minutes,
      ranked.local_time_source AS local_time_source,
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
  if(best.staging_available, best.deep_minutes, NULL) AS deep_minutes,
  if(best.staging_available, best.rem_minutes, NULL) AS rem_minutes,
  if(best.staging_available, best.light_minutes, NULL) AS light_minutes,
  if(best.staging_available, best.awake_minutes, NULL) AS awake_minutes,
  best.staging_available AS staging_available,
  coalesce(
    best.efficiency_pct,
    multiIf(
      best.staging_available
        AND best.provider_id = 'apple_health'
        AND best.duration_minutes > 0,
      round((coalesce(best.deep_minutes, 0) + coalesce(best.rem_minutes, 0) + coalesce(best.light_minutes, 0)) / best.duration_minutes * 100, 1),
      best.staging_available
        AND best.provider_id IN ('eight-sleep', 'polar')
        AND best.duration_minutes > 0
        AND best.awake_minutes IS NOT NULL,
      round(best.duration_minutes / (best.duration_minutes + best.awake_minutes) * 100, 1),
      NULL
    )
  ) AS efficiency_pct,
  best.sleep_type AS sleep_type,
  best.is_nap AS is_nap,
  best.source_name AS source_name,
  best.timezone AS timezone,
  best.start_utc_offset_minutes AS start_utc_offset_minutes,
  best.end_utc_offset_minutes AS end_utc_offset_minutes,
  best.local_time_source AS local_time_source,
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
  best.staging_available,
  best.efficiency_pct,
  best.sleep_type,
  best.is_nap,
  best.source_name,
  best.timezone,
  best.start_utc_offset_minutes,
  best.end_utc_offset_minutes,
  best.local_time_source`;
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
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.provider_connection FINAL
  WHERE _peerdb_is_deleted = 0
  UNION DISTINCT
  SELECT DISTINCT user_id, provider_id
  FROM postgres_fitness.activity FINAL
  WHERE _peerdb_is_deleted = 0
    AND provider_absent_at IS NULL
    AND deleted_at IS NULL
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
  FROM ${METRIC_STREAM_TABLE} FINAL
  WHERE is_deleted = 0
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
  FROM postgres_fitness.clinical_record FINAL
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
    AND provider_absent_at IS NULL
    AND deleted_at IS NULL
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
  FROM ${METRIC_STREAM_TABLE} FINAL
  WHERE is_deleted = 0
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
clinical_record_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.clinical_record FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
journal_entry_counts AS (
  SELECT user_id, provider_id, count() AS count
  FROM postgres_fitness.journal_entry FINAL
  WHERE _peerdb_is_deleted = 0
  GROUP BY user_id, provider_id
),
refresh_clock AS (
  SELECT
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9) AS refreshed_at
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
  coalesce(clinical_record_counts.count, 0) AS clinical_records,
  coalesce(journal_entry_counts.count, 0) AS journal_entries,
  toUInt8(0) AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM providers
CROSS JOIN refresh_clock
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
LEFT JOIN clinical_record_counts
  ON clinical_record_counts.user_id = providers.user_id
 AND clinical_record_counts.provider_id = providers.provider_id
LEFT JOIN journal_entry_counts
  ON journal_entry_counts.user_id = providers.user_id
 AND journal_entry_counts.provider_id = providers.provider_id`;
}

export function buildProviderStatsCreateReadModelStatements(): string[] {
  return [buildProviderStatsReadModelSql()];
}

export function buildProviderStatsReadModelStatements(): string[] {
  return [
    "DROP TABLE IF EXISTS analytics.provider_stats",
    "DROP VIEW IF EXISTS analytics.provider_stats",
    ...buildProviderStatsCreateReadModelStatements(),
  ];
}

export function buildAnalyticsFitnessReadModelStatements(): string[] {
  return [
    buildActivityReadModelSql(),
    buildActivityMembersReadModelSql(),
    buildSleepReadModelSql(),
    buildDailyMetricsReadModelSql(),
    ...buildProviderStatsCreateReadModelStatements(),
  ];
}

export function buildSleepQualityMigrationStatements(): string[] {
  return [
    "ALTER TABLE postgres_fitness.sleep_session ADD COLUMN IF NOT EXISTS staging_available Bool DEFAULT false AFTER efficiency_pct",
    "ALTER TABLE analytics.daily_sleep ADD COLUMN IF NOT EXISTS staging_available Bool DEFAULT false AFTER efficiency_pct",
    "DROP VIEW IF EXISTS analytics.v_sleep",
    buildSleepReadModelSql(),
  ];
}

export function buildAnalyticsFitnessReadModelDropStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.v_activity_members",
    "DROP VIEW IF EXISTS analytics.v_activity",
    "DROP VIEW IF EXISTS analytics.v_sleep",
    "DROP VIEW IF EXISTS analytics.v_daily_metrics",
    "DROP TABLE IF EXISTS analytics.provider_stats",
    "DROP VIEW IF EXISTS analytics.provider_stats",
  ];
}

export function buildActivityUserSoftDeleteMigrationStatements(): string[] {
  return [
    "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS deleted_at Nullable(DateTime64(6, 'UTC'))",
    ...buildAnalyticsFitnessReadModelDropStatements(),
    buildActivityReadModelSql(),
    buildActivityMembersReadModelSql(),
    buildSleepReadModelSql(),
    buildDailyMetricsReadModelSql(),
    buildProviderStatsTableSql(),
  ];
}

export function buildProviderActivityAbsenceMigrationStatements(): string[] {
  return [
    "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS provider_absent_at Nullable(DateTime64(6, 'UTC'))",
    ...buildAnalyticsFitnessReadModelDropStatements(),
    buildActivityReadModelSql(),
    buildActivityMembersReadModelSql(),
    buildSleepReadModelSql(),
    buildDailyMetricsReadModelSql(),
    buildProviderStatsTableSql(),
  ];
}
