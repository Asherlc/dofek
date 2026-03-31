-- ============================================================
-- Migration 0053: Continuous Aggregates on sensor_sample
-- ============================================================
-- Replaces the metric_stream-based cagg_metric_daily/cagg_metric_weekly
-- with new aggregates built on the unified sensor_sample table.
--
-- These aggregate per (day, user_id, channel) so each channel gets its
-- own row — matching the narrow/medium layout of sensor_sample.

-- ============================================================
-- 1. Daily continuous aggregate per (user, channel)
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.cagg_sensor_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', recorded_at) AS bucket,
  user_id,
  channel,
  -- Scalar stats
  AVG(scalar)::REAL    AS avg_value,
  MAX(scalar)::REAL    AS max_value,
  MIN(scalar)::REAL    AS min_value,
  COUNT(*)::INT        AS sample_count
FROM fitness.sensor_sample
WHERE scalar IS NOT NULL
  AND activity_id IS NOT NULL
GROUP BY time_bucket('1 day', recorded_at), user_id, channel
WITH NO DATA;

--> statement-breakpoint

SELECT add_continuous_aggregate_policy('fitness.cagg_sensor_daily',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true
);

--> statement-breakpoint

-- ============================================================
-- 2. Weekly continuous aggregate (hierarchical from daily)
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.cagg_sensor_weekly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('7 days', bucket) AS bucket,
  user_id,
  channel,
  -- Weighted averages using sample counts from daily cagg
  SUM(avg_value * sample_count) / NULLIF(SUM(sample_count), 0)::REAL AS avg_value,
  MAX(max_value)::REAL  AS max_value,
  MIN(min_value)::REAL  AS min_value,
  SUM(sample_count)::INT AS sample_count
FROM fitness.cagg_sensor_daily
GROUP BY time_bucket('7 days', bucket), user_id, channel
WITH NO DATA;

--> statement-breakpoint

SELECT add_continuous_aggregate_policy('fitness.cagg_sensor_weekly',
  start_offset => INTERVAL '28 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => true
);
