import { buildActivitySummaryReadModelStatements } from "../../../../src/db/clickhouse-metric-stream-bootstrap.ts";
import {
  type IsolatedClickHouseDatabases,
  rewriteClickHouseDatabaseNames,
} from "./clickhouse-integration-test-models.ts";

export function buildTestDedupedActivitiesSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
  start_utc_offset_minutes,
  end_utc_offset_minutes,
  coalesce(nullIf(local_time_source, ''), 'unknown') AS local_time_source,
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

export function buildTestActivitySensorSampleSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestActivityLocationSampleSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestActivityLocationSummarySelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
  return `WITH location_deltas AS (
  SELECT
    activity_id,
    user_id,
    lat,
    lng,
    lagInFrame(lat) OVER (
      PARTITION BY user_id, activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS previous_lat,
    lagInFrame(lng) OVER (
      PARTITION BY user_id, activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS previous_lng
  FROM ${databases.analytics}.activity_location_sample FINAL
  WHERE is_deleted = 0
),
distance_per_activity AS (
  SELECT
    activity_id,
    user_id,
    CAST(sum(
      2 * 6371000 * asin(sqrt(
        pow(sin(radians(lat - previous_lat) / 2), 2)
        + cos(radians(previous_lat)) * cos(radians(lat))
        * pow(sin(radians(lng - previous_lng) / 2), 2)
      ))
    ), 'Nullable(Float64)') AS total_distance
  FROM location_deltas
  WHERE previous_lat IS NOT NULL
    AND previous_lng IS NOT NULL
  GROUP BY activity_id, user_id
),
centroid_per_activity AS (
  SELECT
    activity_id,
    user_id,
    CAST(avg(lat), 'Nullable(Float64)') AS centroid_lat,
    CAST(avg(lng), 'Nullable(Float64)') AS centroid_lng
  FROM ${databases.analytics}.activity_location_sample FINAL
  WHERE is_deleted = 0
    AND lat IS NOT NULL
    AND lng IS NOT NULL
  GROUP BY activity_id, user_id
)
SELECT
  activity.activity_id AS activity_id,
  activity.user_id AS user_id,
  distance_per_activity.total_distance AS total_distance,
  centroid_per_activity.centroid_lat AS centroid_lat,
  centroid_per_activity.centroid_lng AS centroid_lng,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  toUInt8(0) AS is_deleted,
  now64(9) AS refreshed_at
FROM ${databases.analytics}.deduped_activities AS activity FINAL
LEFT JOIN distance_per_activity
  ON distance_per_activity.activity_id = activity.activity_id
 AND distance_per_activity.user_id = activity.user_id
LEFT JOIN centroid_per_activity
  ON centroid_per_activity.activity_id = activity.activity_id
 AND centroid_per_activity.user_id = activity.user_id
WHERE activity.is_deleted = 0`;
}

export function buildTestActivitySensorSummarySelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
  return `WITH altitude_deltas AS (
  SELECT
    activity_id,
    user_id,
    scalar AS altitude,
    lagInFrame(scalar) OVER (
      PARTITION BY user_id, activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS previous_altitude
  FROM ${databases.analytics}.activity_sensor_sample FINAL
  WHERE is_deleted = 0
    AND channel = 'altitude'
    AND scalar IS NOT NULL
),
elevation_per_activity AS (
  SELECT
    activity_id,
    user_id,
    CAST(
      sum(if(
        isNotNull(previous_altitude) AND altitude - previous_altitude > 0,
        altitude - previous_altitude,
        0
      )),
      'Nullable(Float64)'
    ) AS elevation_gain_m,
    CAST(
      sum(if(
        isNotNull(previous_altitude) AND altitude - previous_altitude < 0,
        abs(altitude - previous_altitude),
        0
      )),
      'Nullable(Float64)'
    ) AS elevation_loss_m
  FROM altitude_deltas
  GROUP BY activity_id, user_id
)
SELECT
  activity.activity_id AS activity_id,
  activity.user_id AS user_id,
  CAST(NULL, 'Nullable(Float64)') AS avg_hr,
  CAST(NULL, 'Nullable(Int16)') AS max_hr,
  CAST(NULL, 'Nullable(Int16)') AS min_hr,
  CAST(NULL, 'Nullable(Float64)') AS avg_power,
  CAST(NULL, 'Nullable(Int16)') AS max_power,
  CAST(NULL, 'Nullable(Float64)') AS avg_speed,
  CAST(NULL, 'Nullable(Float64)') AS max_speed,
  CAST(NULL, 'Nullable(Float64)') AS avg_cadence,
  CAST(NULL, 'Nullable(Float64)') AS elevation_gain_legacy,
  CAST(NULL, 'Nullable(Float64)') AS avg_left_balance,
  CAST(NULL, 'Nullable(Float64)') AS avg_left_torque_eff,
  CAST(NULL, 'Nullable(Float64)') AS avg_right_torque_eff,
  CAST(NULL, 'Nullable(Float64)') AS avg_left_pedal_smooth,
  CAST(NULL, 'Nullable(Float64)') AS avg_right_pedal_smooth,
  elevation_per_activity.elevation_gain_m AS elevation_gain_m,
  elevation_per_activity.elevation_loss_m AS elevation_loss_m,
  CAST(NULL, 'Nullable(Float64)') AS avg_stance_time,
  CAST(NULL, 'Nullable(Float64)') AS avg_vertical_osc,
  CAST(NULL, 'Nullable(Float64)') AS avg_ground_contact_time,
  CAST(NULL, 'Nullable(Float64)') AS avg_stride_length,
  CAST(NULL, 'Nullable(UInt64)') AS sample_count,
  CAST(NULL, 'Nullable(UInt64)') AS hr_sample_count,
  CAST(NULL, 'Nullable(UInt64)') AS power_sample_count,
  CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS first_sample_at,
  CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS last_sample_at,
  CAST(NULL, 'Nullable(Float64)') AS best_twenty_minute_power,
  CAST(NULL, 'Nullable(Float64)') AS normalized_power,
  CAST(NULL, 'Nullable(Float64)') AS smoothed_avg_power,
  CAST(NULL, 'Nullable(Float64)') AS climbing_elevation_gain_m,
  CAST(NULL, 'Nullable(Int32)') AS climbing_seconds,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  toUInt8(0) AS is_deleted,
  now64(9) AS refreshed_at
FROM ${databases.analytics}.deduped_activities AS activity FINAL
LEFT JOIN elevation_per_activity
  ON elevation_per_activity.activity_id = activity.activity_id
 AND elevation_per_activity.user_id = activity.user_id
WHERE activity.is_deleted = 0`;
}

export function buildTestProviderStatsSelectSql(selectSql: string): string {
  return selectSql;
}

export function buildTestRestingHeartRateSelectSql(databases: IsolatedClickHouseDatabases): string {
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

export function buildTestActivitySummarySelectSql(databases: IsolatedClickHouseDatabases): string {
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

export function buildTestActivityStreamPointsSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestHikingActivitySelectSql(databases: IsolatedClickHouseDatabases): string {
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

export function buildTestActivityHeartRateZonesSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestDailyRecoveryInputsSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
window_statistics AS (
  SELECT
    user_id,
    date,
    hrv,
    resting_hr,
    respiratory_rate,
    efficiency_pct,
    avgOrNull(hrv) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS hrv_mean_30d,
    stddevPop(hrv) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS hrv_sd_30d_raw,
    countIf(hrv IS NOT NULL) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS hrv_baseline_sample_count,
    avgOrNull(hrv) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS hrv_mean_7d,
    avgOrNull(hrv) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
    ) AS hrv_mean_previous_28d,
    avgOrNull(resting_hr) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rhr_mean_30d,
    stddevPop(resting_hr) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rhr_sd_30d_raw,
    countIf(resting_hr IS NOT NULL) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rhr_baseline_sample_count,
    avgOrNull(resting_hr) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rhr_mean_7d,
    avgOrNull(resting_hr) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
    ) AS rhr_mean_previous_28d,
    avgOrNull(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rr_mean_30d,
    stddevPop(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rr_sd_30d_raw,
    countIf(respiratory_rate IS NOT NULL) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS rr_baseline_sample_count,
    avgOrNull(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rr_mean_7d,
    avgOrNull(respiratory_rate) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
    ) AS rr_mean_previous_28d,
    avgOrNull(efficiency_pct) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS efficiency_mean_30d,
    stddevPop(efficiency_pct) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS efficiency_sd_30d_raw,
    countIf(efficiency_pct IS NOT NULL) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS efficiency_baseline_sample_count,
    avgOrNull(efficiency_pct) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS efficiency_mean_7d,
    avgOrNull(efficiency_pct) OVER (
      PARTITION BY user_id ORDER BY toUInt32(date)
      RANGE BETWEEN 34 PRECEDING AND 7 PRECEDING
    ) AS efficiency_mean_previous_28d,
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
inputs_with_baselines AS (
  SELECT
    * EXCEPT (
      hrv_sd_30d_raw,
      rhr_sd_30d_raw,
      rr_sd_30d_raw,
      efficiency_sd_30d_raw
    ),
    if(
      hrv_baseline_sample_count >= 2,
      hrv_sd_30d_raw,
      CAST(NULL, 'Nullable(Float64)')
    ) AS hrv_sd_30d,
    hrv_baseline_sample_count / 30.0 AS hrv_baseline_coverage,
    if(
      rhr_baseline_sample_count >= 2,
      rhr_sd_30d_raw,
      CAST(NULL, 'Nullable(Float64)')
    ) AS rhr_sd_30d,
    rhr_baseline_sample_count / 30.0 AS rhr_baseline_coverage,
    if(
      rr_baseline_sample_count >= 2,
      rr_sd_30d_raw,
      CAST(NULL, 'Nullable(Float64)')
    ) AS rr_sd_30d,
    rr_baseline_sample_count / 30.0 AS rr_baseline_coverage,
    if(
      efficiency_baseline_sample_count >= 2,
      efficiency_sd_30d_raw,
      CAST(NULL, 'Nullable(Float64)')
    ) AS efficiency_sd_30d,
    efficiency_baseline_sample_count / 30.0 AS efficiency_baseline_coverage
  FROM window_statistics
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
  inputs_with_baselines.hrv_baseline_sample_count AS hrv_baseline_sample_count,
  inputs_with_baselines.hrv_baseline_coverage AS hrv_baseline_coverage,
  inputs_with_baselines.hrv_mean_7d AS hrv_mean_7d,
  inputs_with_baselines.hrv_mean_previous_28d AS hrv_mean_previous_28d,
  inputs_with_baselines.rhr_mean_30d AS rhr_mean_30d,
  inputs_with_baselines.rhr_sd_30d AS rhr_sd_30d,
  inputs_with_baselines.rhr_baseline_sample_count AS rhr_baseline_sample_count,
  inputs_with_baselines.rhr_baseline_coverage AS rhr_baseline_coverage,
  inputs_with_baselines.rhr_mean_7d AS rhr_mean_7d,
  inputs_with_baselines.rhr_mean_previous_28d AS rhr_mean_previous_28d,
  inputs_with_baselines.rr_mean_30d AS rr_mean_30d,
  inputs_with_baselines.rr_sd_30d AS rr_sd_30d,
  inputs_with_baselines.rr_baseline_sample_count AS rr_baseline_sample_count,
  inputs_with_baselines.rr_baseline_coverage AS rr_baseline_coverage,
  inputs_with_baselines.rr_mean_7d AS rr_mean_7d,
  inputs_with_baselines.rr_mean_previous_28d AS rr_mean_previous_28d,
  inputs_with_baselines.efficiency_mean_30d AS efficiency_mean_30d,
  inputs_with_baselines.efficiency_sd_30d AS efficiency_sd_30d,
  inputs_with_baselines.efficiency_baseline_sample_count AS efficiency_baseline_sample_count,
  inputs_with_baselines.efficiency_baseline_coverage AS efficiency_baseline_coverage,
  inputs_with_baselines.efficiency_mean_7d AS efficiency_mean_7d,
  inputs_with_baselines.efficiency_mean_previous_28d AS efficiency_mean_previous_28d,
  inputs_with_baselines.hrv_mean_60d AS hrv_mean_60d,
  inputs_with_baselines.hrv_sd_60d AS hrv_sd_60d,
  inputs_with_baselines.rhr_mean_60d AS rhr_mean_60d,
  inputs_with_baselines.rhr_sd_60d AS rhr_sd_60d,
  0 AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM inputs_with_baselines
CROSS JOIN refresh_clock`;
}
