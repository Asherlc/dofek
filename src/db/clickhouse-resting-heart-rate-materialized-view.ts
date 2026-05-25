export function buildRestingHeartRateSleepWindowMaterializedViewSql(): string {
  return `CREATE VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window
AS
WITH sleep_windows AS (
  SELECT
    id AS sleep_id,
    user_id,
    started_at,
    ended_at,
    dateDiff('second', started_at, ended_at) AS duration_seconds
  FROM analytics.v_sleep
  WHERE is_nap = false
    AND ended_at IS NOT NULL
),
heart_rate_samples AS (
  SELECT
    sleep_windows.sleep_id AS sleep_id,
    sleep_windows.user_id AS user_id,
    sleep_windows.started_at AS started_at,
    sleep_windows.ended_at AS ended_at,
    sleep_windows.duration_seconds AS duration_seconds,
    samples.scalar AS heart_rate
  FROM sleep_windows
  INNER JOIN analytics.deduped_sensor AS samples
    ON samples.user_id = sleep_windows.user_id
  LEFT JOIN (
    SELECT
      toNullable(id) AS activity_id,
      user_id,
      started_at,
      ended_at
    FROM analytics.v_activity
  ) AS activity
    ON activity.user_id = samples.user_id
   AND samples.recorded_at >= activity.started_at
   AND samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
  WHERE samples.channel = 'heart_rate'
    AND samples.recorded_at >= sleep_windows.started_at
    AND samples.recorded_at <= sleep_windows.ended_at
    AND samples.is_deleted = 0
    AND samples.scalar IS NOT NULL
    AND activity.activity_id IS NULL
)
SELECT
  sleep_id,
  user_id,
  any(started_at) AS started_at,
  any(ended_at) AS ended_at,
  any(duration_seconds) AS duration_seconds,
  count() AS sample_count,
  toInt32(round(arrayAvg(arraySlice(
    arraySort(groupArray(toFloat64(heart_rate))),
    1,
    greatest(toInt32(ceil(count() * 0.10)), 1)
  )))) AS resting_hr
FROM heart_rate_samples
GROUP BY sleep_id, user_id
HAVING sample_count >= 30`;
}

export function buildRestingHeartRateSleepWindowMaterializedViewStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.resting_heart_rate_sleep_window",
    "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window",
    buildRestingHeartRateSleepWindowMaterializedViewSql(),
  ];
}
