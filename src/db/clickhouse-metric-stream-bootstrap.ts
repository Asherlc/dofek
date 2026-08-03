import {
  buildAccountErasureFenceTableSql,
  buildAccountErasureOperationFenceTableSql,
  buildIngestMetricStreamCreateTableSql,
  buildMetricStreamDeleteAcknowledgementTableSql,
  buildMetricStreamProcessingAcknowledgementTableSql,
  buildProviderDataGenerationTableSql,
  INGEST_DATABASE,
  METRIC_STREAM_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import { buildIncrementalActivitySummaryStatements } from "./clickhouse-activity-summary.ts";
import { buildActivityTrendDailyCreateReadModelStatements } from "./clickhouse-activity-trend-read-model.ts";
import { buildIncrementalDedupedSensorStatements } from "./clickhouse-deduped-sensor.ts";
import { buildPostgresFitnessRawTableStatements } from "./clickhouse-raw-tables.ts";
import {
  buildAnalyticsFitnessReadModelStatements,
  buildBodyMeasurementSampleProjectionStatements,
} from "./clickhouse-read-models.ts";
import { buildRestingHeartRateSleepWindowTableSql } from "./clickhouse-resting-heart-rate.ts";
import { standardViewHeader } from "./clickhouse-sql-helpers.ts";

export function buildClickHouseBootstrapStatementsForNativeMetricStream(
  postgresConnectionString: string,
): string[] {
  void postgresConnectionString;
  const metricStreamStatements = [
    `CREATE DATABASE IF NOT EXISTS ${INGEST_DATABASE}`,
    buildIngestMetricStreamCreateTableSql(),
    buildMetricStreamDeleteAcknowledgementTableSql(),
    buildMetricStreamProcessingAcknowledgementTableSql(),
    buildProviderDataGenerationTableSql(),
    buildAccountErasureFenceTableSql(),
    buildAccountErasureOperationFenceTableSql(),
    "CREATE DATABASE IF NOT EXISTS postgres_fitness",
    ...buildPostgresFitnessRawTableStatements(),
    ...buildBodyMeasurementSampleProjectionStatements(),
  ];

  return [
    "CREATE DATABASE IF NOT EXISTS analytics",
    ...metricStreamStatements,
    ...buildAnalyticsFitnessReadModelStatements(),
    ...buildIncrementalDedupedSensorStatements(),
    buildRestingHeartRateSleepWindowTableSql(),
    ...buildDedupedLocationReadModelStatements(),
    ...buildIncrementalActivitySummaryStatements(),
    ...buildActivityTrendDailyCreateReadModelStatements(),
  ];
}

export function buildDedupedLocationReadModelStatements(): string[] {
  return [
    `${standardViewHeader("analytics.deduped_location")}
WITH
activity_members AS (
  SELECT
    activity_id,
    user_id,
    member_activity_id
  FROM analytics.v_activity_members
),
linked_best_source AS (
  -- Pick one coherent route source per activity. Point-by-point GPS dedupe can
  -- stitch together provider tracks with different smoothing, sampling rates,
  -- pause handling, and timestamp rounding, which distorts route-derived math.
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
      FROM ${METRIC_STREAM_TABLE} FINAL
    ) AS metric_stream
    INNER JOIN activity_members
      ON metric_stream.activity_id = activity_members.member_activity_id
    WHERE metric_stream.is_deleted = 0
      AND metric_stream.channel = 'location'
      AND metric_stream.point != ''
    GROUP BY activity_members.activity_id, metric_stream.provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
),
parsed_points AS (
  SELECT
    metric_stream.id,
    metric_stream.activity_id,
    metric_stream.user_id,
    metric_stream.recorded_at,
    metric_stream.provider_id,
    metric_stream.channel,
    metric_stream.is_deleted,
    (
      JSONExtract(metric_stream.point, 'coordinates', 'Array(Float64)')[1],
      JSONExtract(metric_stream.point, 'coordinates', 'Array(Float64)')[2]
    )::Point AS point
  FROM (SELECT * FROM ${METRIC_STREAM_TABLE} FINAL) AS metric_stream
  WHERE metric_stream.is_deleted = 0
    AND metric_stream.channel = 'location'
    AND metric_stream.point != ''
)
SELECT
  activity_members.activity_id AS activity_id,
  activity_members.user_id AS user_id,
  parsed_points.recorded_at AS recorded_at,
  max(parsed_points.point.2) AS lat,
  max(parsed_points.point.1) AS lng
FROM parsed_points
INNER JOIN activity_members
  ON parsed_points.activity_id = activity_members.member_activity_id
INNER JOIN linked_best_source
  ON linked_best_source.activity_id = activity_members.activity_id
 AND linked_best_source.provider_id = parsed_points.provider_id
GROUP BY activity_members.activity_id, activity_members.user_id, parsed_points.recorded_at`,
  ];
}

export function buildActivitySummaryReadModelStatements(
  viewName = "analytics.activity_summary",
): string[] {
  return [
    `${standardViewHeader(viewName)}
WITH
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
deduped_samples AS (
  SELECT
    activity_bounds.activity_id AS activity_id,
    sensor_samples.user_id AS user_id,
    sensor_samples.recorded_at AS recorded_at,
    sensor_samples.channel AS channel,
    sensor_samples.scalar AS scalar
  FROM activity_bounds
  INNER JOIN analytics.deduped_sensor AS sensor_samples
    ON sensor_samples.user_id = activity_bounds.user_id
   AND sensor_samples.recorded_at >= activity_bounds.started_at
   AND sensor_samples.recorded_at <= coalesce(activity_bounds.ended_at, activity_bounds.started_at + INTERVAL 12 HOUR)
  WHERE sensor_samples.is_deleted = 0
    AND sensor_samples.scalar IS NOT NULL
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
    CAST(
      sum(if(
        isNotNull(prev_altitude) AND altitude - prev_altitude > 0,
        altitude - prev_altitude,
        0
      )),
      'Nullable(Float64)'
    ) AS elevation_gain_m,
    CAST(
      sum(if(
        isNotNull(prev_altitude) AND altitude - prev_altitude < 0,
        abs(altitude - prev_altitude),
        0
      )),
      'Nullable(Float64)'
    ) AS elevation_loss_m
  FROM altitude_deltas
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
location_centroids AS (
  SELECT
    activity_id,
    CAST(avg(lat), 'Nullable(Float64)') AS centroid_lat,
    CAST(avg(lng), 'Nullable(Float64)') AS centroid_lng
  FROM gps_points
  WHERE lat IS NOT NULL
    AND lng IS NOT NULL
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
),
power_cumulative AS (
  SELECT
    activity_id,
    recorded_at,
    row_number() OVER (PARTITION BY activity_id ORDER BY recorded_at) AS sample_index,
    sum(coalesce(scalar, 0)) OVER (
      PARTITION BY activity_id ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_power
  FROM deduped_samples
  WHERE channel = 'power'
),
power_sample_rate AS (
  SELECT
    activity_id,
    greatest(toInt32(round(
      dateDiff('second', min(recorded_at), max(recorded_at)) / greatest(count() - 1, 1)
    )), 1) AS interval_seconds
  FROM power_cumulative
  GROUP BY activity_id
  HAVING count() > 1
),
best_twenty_minute_power_per_activity AS (
  SELECT
    current_power.activity_id AS activity_id,
    CAST(max(
      toFloat64(current_power.cumulative_power - prior_power.cumulative_power)
      / greatest(round(1200.0 / power_sample_rate.interval_seconds), 1)
    ), 'Nullable(Float64)') AS best_twenty_minute_power
  FROM power_cumulative AS current_power
  INNER JOIN power_sample_rate ON power_sample_rate.activity_id = current_power.activity_id
  INNER JOIN power_cumulative AS prior_power
    ON prior_power.activity_id = current_power.activity_id
   AND toInt64(prior_power.sample_index)
       = toInt64(current_power.sample_index) - toInt64(greatest(round(1200.0 / power_sample_rate.interval_seconds), 1))
  WHERE toInt64(current_power.sample_index) >= toInt64(greatest(round(1200.0 / power_sample_rate.interval_seconds), 1))
  GROUP BY current_power.activity_id
),
rolling_power AS (
  SELECT
    activity_id,
    avg(scalar) OVER (
      PARTITION BY activity_id ORDER BY toUnixTimestamp(recorded_at)
      RANGE BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rolling_30s_power
  FROM deduped_samples
  WHERE channel = 'power' AND scalar > 0
),
power_variability_per_activity AS (
  SELECT
    activity_id,
    CAST(pow(avg(pow(rolling_30s_power, 4)), 0.25), 'Nullable(Float64)') AS normalized_power,
    CAST(avg(rolling_30s_power), 'Nullable(Float64)') AS smoothed_avg_power
  FROM rolling_power
  GROUP BY activity_id
  HAVING count() >= 60
),
climb_altitude_points AS (
  SELECT
    activity_id,
    scalar AS altitude,
    recorded_at,
    lagInFrame(scalar) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_altitude,
    lagInFrame(recorded_at) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_recorded_at
  FROM deduped_samples
  WHERE channel = 'altitude'
),
climb_grade_activities AS (
  SELECT DISTINCT
    activity_id,
    1 AS has_grade_samples
  FROM deduped_samples
  WHERE channel = 'grade'
),
climb_grade_points AS (
  SELECT
    activity_id,
    recorded_at,
    scalar AS grade
  FROM deduped_samples
  WHERE channel = 'grade'
),
climbing_segments AS (
  SELECT
    climb_altitude_points.activity_id AS activity_id,
    climb_altitude_points.recorded_at AS recorded_at,
    climb_altitude_points.altitude AS altitude,
    climb_altitude_points.prev_altitude AS prev_altitude,
    climb_altitude_points.prev_recorded_at AS prev_recorded_at,
    climb_grade_points.grade AS grade,
    coalesce(climb_grade_activities.has_grade_samples, 0) = 1 AS has_grade_samples,
    row_number() OVER (
      PARTITION BY climb_altitude_points.activity_id, climb_altitude_points.recorded_at
      ORDER BY
        if(climb_grade_points.recorded_at IS NULL, 1, 0) ASC,
        abs(dateDiff('second', climb_grade_points.recorded_at, climb_altitude_points.recorded_at)) ASC,
        climb_grade_points.recorded_at ASC
    ) AS grade_rank
  FROM climb_altitude_points
  LEFT JOIN climb_grade_activities
    ON climb_grade_activities.activity_id = climb_altitude_points.activity_id
  LEFT JOIN climb_grade_points
    ON climb_grade_points.activity_id = climb_altitude_points.activity_id
   AND climb_grade_points.recorded_at BETWEEN climb_altitude_points.recorded_at - INTERVAL 5 SECOND
                                          AND climb_altitude_points.recorded_at + INTERVAL 5 SECOND
),
climbing_per_activity AS (
  SELECT
    activity_id,
    CAST(sum(altitude - prev_altitude), 'Nullable(Float64)') AS climbing_elevation_gain_m,
    CAST(sum(dateDiff('second', prev_recorded_at, recorded_at)), 'Nullable(Int32)') AS climbing_seconds
  FROM climbing_segments
  WHERE prev_altitude IS NOT NULL
    AND prev_recorded_at IS NOT NULL
    AND altitude > prev_altitude
    AND grade_rank = 1
    AND (NOT coalesce(has_grade_samples, false) OR grade > 3)
  GROUP BY activity_id
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
     distance_per_activity.total_distance) AS total_distance,
  location_centroids.centroid_lat AS centroid_lat,
  location_centroids.centroid_lng AS centroid_lng,
  channel_aggs.avg_left_balance AS avg_left_balance,
  channel_aggs.avg_left_torque_eff AS avg_left_torque_eff,
  channel_aggs.avg_right_torque_eff AS avg_right_torque_eff,
  channel_aggs.avg_left_pedal_smooth AS avg_left_pedal_smooth,
  channel_aggs.avg_right_pedal_smooth AS avg_right_pedal_smooth,
  elevation_per_activity.elevation_gain_m AS elevation_gain_m,
  elevation_per_activity.elevation_loss_m AS elevation_loss_m,
  channel_aggs.avg_stance_time AS avg_stance_time,
  channel_aggs.avg_vertical_osc AS avg_vertical_osc,
  channel_aggs.avg_ground_contact_time AS avg_ground_contact_time,
  channel_aggs.avg_stride_length AS avg_stride_length,
  channel_aggs.sample_count AS sample_count,
  channel_aggs.hr_sample_count AS hr_sample_count,
  channel_aggs.power_sample_count AS power_sample_count,
  channel_aggs.first_sample_at AS first_sample_at,
  channel_aggs.last_sample_at AS last_sample_at,
  best_twenty_minute_power_per_activity.best_twenty_minute_power AS best_twenty_minute_power,
  power_variability_per_activity.normalized_power AS normalized_power,
  power_variability_per_activity.smoothed_avg_power AS smoothed_avg_power,
  climbing_per_activity.climbing_elevation_gain_m AS climbing_elevation_gain_m,
  climbing_per_activity.climbing_seconds AS climbing_seconds,
  now64(9) AS refreshed_at
FROM activity_bounds
LEFT JOIN channel_aggs
  ON channel_aggs.activity_id = activity_bounds.activity_id
LEFT JOIN elevation_per_activity
  ON elevation_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN distance_per_activity
  ON distance_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN location_centroids
  ON location_centroids.activity_id = activity_bounds.activity_id
LEFT JOIN best_twenty_minute_power_per_activity
  ON best_twenty_minute_power_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN power_variability_per_activity
  ON power_variability_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN climbing_per_activity
  ON climbing_per_activity.activity_id = activity_bounds.activity_id`,
  ];
}
