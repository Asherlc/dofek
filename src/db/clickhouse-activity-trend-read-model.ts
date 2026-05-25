import { standardViewHeader } from "./clickhouse-sql-helpers.ts";

function buildActivityTrendDailyReadModelSql(): string {
  return `${standardViewHeader("analytics.activity_trend_daily")}
WITH activity_samples AS (
  SELECT
    activity.user_id AS user_id,
    activity.id AS activity_id,
    toDate(samples.recorded_at) AS bucket_date,
    samples.recorded_at AS recorded_at,
    samples.channel AS channel,
    samples.scalar AS scalar
  FROM analytics.v_activity AS activity
  INNER JOIN analytics.deduped_sensor AS samples
    ON samples.user_id = activity.user_id
  WHERE samples.recorded_at >= activity.started_at
    AND samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
    AND samples.is_deleted = 0
    AND samples.scalar IS NOT NULL
),
distinct_samples AS (
  SELECT DISTINCT
    user_id,
    bucket_date,
    recorded_at,
    channel,
    scalar
  FROM activity_samples
),
sample_metrics AS (
SELECT
  distinct_samples.user_id AS user_id,
  distinct_samples.bucket_date AS bucket_date,
  CAST(avgIf(distinct_samples.scalar, distinct_samples.channel = 'heart_rate'), 'Nullable(Float64)') AS avg_hr,
  CAST(maxIf(distinct_samples.scalar, distinct_samples.channel = 'heart_rate'), 'Nullable(Int16)') AS max_hr,
  CAST(avgIf(distinct_samples.scalar, distinct_samples.channel = 'power' AND distinct_samples.scalar > 0), 'Nullable(Float64)') AS avg_power,
  CAST(maxIf(distinct_samples.scalar, distinct_samples.channel = 'power' AND distinct_samples.scalar > 0), 'Nullable(Int16)') AS max_power,
  CAST(avgIf(distinct_samples.scalar, distinct_samples.channel = 'cadence' AND distinct_samples.scalar > 0), 'Nullable(Float64)') AS avg_cadence,
  CAST(avgIf(distinct_samples.scalar, distinct_samples.channel = 'speed'), 'Nullable(Float64)') AS avg_speed,
  count() AS total_samples,
  countIf(distinct_samples.channel = 'heart_rate') AS hr_samples,
  countIf(distinct_samples.channel = 'power' AND distinct_samples.scalar > 0) AS power_samples,
  countIf(distinct_samples.channel = 'cadence' AND distinct_samples.scalar > 0) AS cadence_samples,
  countIf(distinct_samples.channel = 'speed') AS speed_samples
FROM distinct_samples
GROUP BY distinct_samples.user_id, distinct_samples.bucket_date
),
activity_counts AS (
  SELECT
    user_id,
    bucket_date,
    uniqExact(activity_id) AS activity_count
  FROM activity_samples
  GROUP BY user_id, bucket_date
)
SELECT
  sample_metrics.user_id AS user_id,
  sample_metrics.bucket_date AS bucket_date,
  sample_metrics.avg_hr AS avg_hr,
  sample_metrics.max_hr AS max_hr,
  sample_metrics.avg_power AS avg_power,
  sample_metrics.max_power AS max_power,
  sample_metrics.avg_cadence AS avg_cadence,
  sample_metrics.avg_speed AS avg_speed,
  sample_metrics.total_samples AS total_samples,
  sample_metrics.hr_samples AS hr_samples,
  sample_metrics.power_samples AS power_samples,
  sample_metrics.cadence_samples AS cadence_samples,
  sample_metrics.speed_samples AS speed_samples,
  activity_counts.activity_count AS activity_count
FROM sample_metrics
INNER JOIN activity_counts
  ON activity_counts.user_id = sample_metrics.user_id
 AND activity_counts.bucket_date = sample_metrics.bucket_date`;
}

export function buildActivityTrendDailyCreateReadModelStatements(): string[] {
  return [buildActivityTrendDailyReadModelSql()];
}

export function buildActivityTrendDailyReadModelStatements(): string[] {
  return [
    "DROP VIEW IF EXISTS analytics.activity_trend_daily",
    "DROP TABLE IF EXISTS analytics.activity_trend_daily",
    ...buildActivityTrendDailyCreateReadModelStatements(),
  ];
}
