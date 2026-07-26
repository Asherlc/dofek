import type { IsolatedClickHouseDatabases } from "./clickhouse-integration-test-models.ts";

export function buildTestDailySleepSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH ranked_sleep AS (
  SELECT
    user_id,
    toDate(started_at - INTERVAL 6 HOUR) AS date,
    provider_id,
    source_name,
    source_providers,
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
  ranked_sleep.source_name AS source_name,
  ranked_sleep.source_providers AS source_providers,
  ranked_sleep.started_at AS started_at,
  ranked_sleep.ended_at AS ended_at,
  ranked_sleep.duration_minutes AS duration_minutes,
  ranked_sleep.deep_minutes AS deep_minutes,
  ranked_sleep.rem_minutes AS rem_minutes,
  ranked_sleep.light_minutes AS light_minutes,
  ranked_sleep.awake_minutes AS awake_minutes,
  ranked_sleep.efficiency_pct AS efficiency_pct,
  refresh_clock.refresh_version AS refresh_version,
  toUInt8(0) AS is_deleted,
  refresh_clock.refreshed_at AS refreshed_at
FROM ranked_sleep
CROSS JOIN refresh_clock
WHERE ranked_sleep.row_number = 1`;
}

export function buildTestDailyActivityLoadSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
  toUInt8(0) AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM activity_load
CROSS JOIN refresh_clock`;
}

export function buildTestDailyEnduranceLoadSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestWeeklyEnduranceRampRateSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestWeeklyTrainingMonotonySelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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

export function buildTestDailyBodyMeasurementSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
  0 AS is_deleted,
  refresh_clock.refreshed_at AS source_synced_at,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM body_source
CROSS JOIN refresh_clock`;
}

export function buildTestRecoveryReadModelSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
  0 AS is_deleted,
  refresh_version,
  refreshed_at
FROM ${databases.analytics}.daily_recovery_inputs
WHERE is_deleted = 0`;
}

export function buildTestStrainReadModelSelectSql(databases: IsolatedClickHouseDatabases): string {
  return `WITH activity_load AS (
  SELECT
    user_id,
    toDate(started_at) AS date,
    coalesce(sum(daily_load), 0) AS daily_load
  FROM ${databases.analytics}.daily_activity_load FINAL
  WHERE is_deleted = 0
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
  toUInt8(0) AS is_deleted,
  refresh_clock.refresh_version AS refresh_version,
  refresh_clock.refreshed_at AS refreshed_at
FROM with_windows
CROSS JOIN refresh_clock`;
}

export function buildTestHealthspanReadModelSelectSql(
  databases: IsolatedClickHouseDatabases,
): string {
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
  FROM ${databases.analytics}.daily_body_measurement FINAL
  WHERE is_deleted = 0
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
  FROM ${databases.analytics}.daily_body_measurement FINAL
  WHERE is_deleted = 0
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

export function buildTestHealthspanActivityZoneMinutesSelectSql(
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
