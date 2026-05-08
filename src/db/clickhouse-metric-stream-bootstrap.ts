import { buildPostgresFitnessRawTableStatements } from "./clickhouse-raw-tables.ts";
import {
  buildActivityTrendDailyCreateReadModelStatements,
  buildAnalyticsFitnessReadModelStatements,
} from "./clickhouse-read-models.ts";
import {
  peerDbMetadataColumnDefinitions,
  replacingMergeTreeTable,
} from "./clickhouse-sql-helpers.ts";

export function buildClickHouseBootstrapStatementsForNativeMetricStream(
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
  latitude Nullable(Float32),
  longitude Nullable(Float32),
  metadata Nullable(String),
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
standalone_best_source AS (
  SELECT
    best_source.user_id AS user_id,
    best_source.date AS date,
    best_source.channel AS channel,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      metric_stream.metric_user_id AS user_id,
      toDate(metric_stream.metric_recorded_at) AS date,
      metric_stream.metric_channel AS channel,
      metric_stream.metric_provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY metric_stream.metric_user_id, toDate(metric_stream.metric_recorded_at), metric_stream.metric_channel
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
    WHERE metric_stream.metric_activity_id IS NULL
      AND metric_stream.metric_scalar IS NOT NULL
    GROUP BY metric_stream.metric_user_id, toDate(metric_stream.metric_recorded_at), metric_stream.metric_channel, metric_stream.metric_provider_id
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
),
standalone_samples AS (
  SELECT
    CAST(NULL, 'Nullable(UUID)') AS activity_id,
    metric_stream.metric_user_id AS user_id,
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
  INNER JOIN standalone_best_source
    ON standalone_best_source.user_id = metric_stream.metric_user_id
   AND standalone_best_source.date = toDate(metric_stream.metric_recorded_at)
   AND standalone_best_source.channel = metric_stream.metric_channel
   AND standalone_best_source.provider_id = metric_stream.metric_provider_id
  WHERE metric_stream.metric_activity_id IS NULL
    AND metric_stream.metric_scalar IS NOT NULL
  GROUP BY metric_stream.metric_user_id, metric_stream.metric_recorded_at, metric_stream.metric_channel
)
SELECT
  CAST(linked_samples.activity_id, 'Nullable(UUID)') AS activity_id,
  linked_samples.user_id AS user_id,
  linked_samples.recorded_at AS recorded_at,
  linked_samples.channel AS channel,
  linked_samples.scalar AS scalar
FROM linked_samples
UNION ALL
SELECT
  CAST(ambient_samples.activity_id, 'Nullable(UUID)') AS activity_id,
  ambient_samples.user_id AS user_id,
  ambient_samples.recorded_at AS recorded_at,
  ambient_samples.channel AS channel,
  ambient_samples.scalar AS scalar
FROM ambient_samples
UNION ALL
SELECT
  standalone_samples.activity_id AS activity_id,
  standalone_samples.user_id AS user_id,
  standalone_samples.recorded_at AS recorded_at,
  standalone_samples.channel AS channel,
  standalone_samples.scalar AS scalar
FROM standalone_samples`,
    "SYSTEM REFRESH VIEW analytics.deduped_sensor",
    "SYSTEM WAIT VIEW analytics.deduped_sensor",
    `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_location
REFRESH EVERY 1 MINUTE
ENGINE = MergeTree
ORDER BY (user_id, activity_id, recorded_at)
AS
WITH
activity_members AS (
  SELECT
    activity_id,
    user_id,
    member_activity_id
  FROM analytics.v_activity_members
),
linked_best_source AS (
  SELECT
    best_source.activity_id AS activity_id,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      activity_members.activity_id AS activity_id,
      metric_stream.provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY activity_members.activity_id
        ORDER BY count() DESC, metric_stream.provider_id ASC
      ) AS row_number
    FROM (
      SELECT *
      FROM postgres_fitness.metric_stream FINAL
    ) AS metric_stream
    INNER JOIN activity_members
      ON metric_stream.activity_id = activity_members.member_activity_id
    WHERE metric_stream._peerdb_is_deleted = 0
      AND metric_stream.channel = 'location'
      AND metric_stream.latitude IS NOT NULL
      AND metric_stream.longitude IS NOT NULL
    GROUP BY activity_members.activity_id, metric_stream.provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
)
SELECT
  activity_members.activity_id AS activity_id,
  activity_members.user_id AS user_id,
  metric_stream.recorded_at AS recorded_at,
  max(metric_stream.latitude) AS lat,
  max(metric_stream.longitude) AS lng
FROM (
  SELECT *
  FROM postgres_fitness.metric_stream FINAL
) AS metric_stream
INNER JOIN activity_members
  ON metric_stream.activity_id = activity_members.member_activity_id
INNER JOIN linked_best_source
  ON linked_best_source.activity_id = activity_members.activity_id
 AND linked_best_source.provider_id = metric_stream.provider_id
WHERE metric_stream._peerdb_is_deleted = 0
  AND metric_stream.channel = 'location'
  AND metric_stream.latitude IS NOT NULL
  AND metric_stream.longitude IS NOT NULL
GROUP BY activity_members.activity_id, activity_members.user_id, metric_stream.recorded_at`,
    "SYSTEM REFRESH VIEW analytics.deduped_location",
    "SYSTEM WAIT VIEW analytics.deduped_location",
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
    activity_id,
    recorded_at,
    lat,
    lng
  FROM analytics.deduped_location
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
    ...buildActivityTrendDailyCreateReadModelStatements(),
  ];
}
