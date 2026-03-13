-- ============================================================
-- Migration 0027: Continuous Aggregates for Long-Range Trends
-- ============================================================
-- TimescaleDB continuous aggregates on metric_stream for efficient
-- queries over months/years of data. These auto-refresh via policies,
-- unlike the existing materialized views that need manual REFRESH.
--
-- Hierarchy: metric_stream → daily → weekly
--
-- The daily cagg pre-computes per-user daily stats from the raw
-- second-by-second metric_stream. The weekly cagg rolls up from
-- the daily cagg (hierarchical continuous aggregate).

-- ============================================================
-- 1. Daily continuous aggregate
-- ============================================================
-- Pre-aggregates metric_stream into one row per (day, user_id).
-- Covers HR, power, cadence, speed, altitude, and sample counts.

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.cagg_metric_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', recorded_at) AS bucket,
  user_id,
  -- Heart rate
  AVG(heart_rate)::REAL           AS avg_hr,
  MAX(heart_rate)::SMALLINT       AS max_hr,
  MIN(heart_rate)::SMALLINT       AS min_hr,
  -- Power
  AVG(power) FILTER (WHERE power > 0)::REAL      AS avg_power,
  MAX(power) FILTER (WHERE power > 0)::SMALLINT   AS max_power,
  -- Cadence / Speed / Altitude
  AVG(cadence) FILTER (WHERE cadence > 0)::REAL   AS avg_cadence,
  AVG(speed)::REAL                AS avg_speed,
  MAX(speed)::REAL                AS max_speed,
  MAX(altitude)::REAL             AS max_altitude,
  MIN(altitude) FILTER (WHERE altitude IS NOT NULL)::REAL AS min_altitude,
  -- Sample counts
  COUNT(*)::INT                   AS total_samples,
  COUNT(heart_rate)::INT          AS hr_samples,
  COUNT(power) FILTER (WHERE power > 0)::INT AS power_samples,
  COUNT(cadence) FILTER (WHERE cadence > 0)::INT AS cadence_samples,
  -- Activity count (distinct activities that day)
  COUNT(DISTINCT activity_id)::INT AS activity_count
FROM fitness.metric_stream
WHERE activity_id IS NOT NULL
GROUP BY time_bucket('1 day', recorded_at), user_id
WITH NO DATA;

--> statement-breakpoint

-- Refresh policy: run every hour, refresh the last 3 days of data.
-- The end_offset of 1 hour means we don't aggregate the very latest
-- data (which may still be arriving). The start_offset of 3 days
-- ensures any late-arriving or corrected data gets picked up.
SELECT add_continuous_aggregate_policy('fitness.cagg_metric_daily',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true
);

--> statement-breakpoint

-- ============================================================
-- 2. Weekly continuous aggregate (hierarchical from daily)
-- ============================================================
-- Rolls up the daily cagg into weekly buckets for long-range views.

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.cagg_metric_weekly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('7 days', bucket)   AS bucket,
  user_id,
  -- Weighted averages using sample counts from daily cagg
  SUM(avg_hr * hr_samples) / NULLIF(SUM(hr_samples), 0)::REAL         AS avg_hr,
  MAX(max_hr)::SMALLINT           AS max_hr,
  MIN(min_hr)::SMALLINT           AS min_hr,
  SUM(avg_power * power_samples) / NULLIF(SUM(power_samples), 0)::REAL AS avg_power,
  MAX(max_power)::SMALLINT        AS max_power,
  SUM(avg_cadence * cadence_samples) / NULLIF(SUM(cadence_samples), 0)::REAL AS avg_cadence,
  SUM(avg_speed * total_samples) / NULLIF(SUM(total_samples), 0)::REAL AS avg_speed,
  MAX(max_speed)::REAL            AS max_speed,
  MAX(max_altitude)::REAL         AS max_altitude,
  MIN(min_altitude)::REAL         AS min_altitude,
  SUM(total_samples)::INT         AS total_samples,
  SUM(hr_samples)::INT            AS hr_samples,
  SUM(power_samples)::INT         AS power_samples,
  SUM(cadence_samples)::INT       AS cadence_samples,
  SUM(activity_count)::INT        AS activity_count
FROM fitness.cagg_metric_daily
GROUP BY time_bucket('7 days', bucket), user_id
WITH NO DATA;

--> statement-breakpoint

-- Refresh policy: run daily, refresh the last 4 weeks.
SELECT add_continuous_aggregate_policy('fitness.cagg_metric_weekly',
  start_offset => INTERVAL '28 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => true
);
