-- Add pre-computed HR zone time columns to activity_summary.
--
-- The healthspan query was scanning metric_stream with expensive LEAD/LAG window
-- functions at query time to compute aerobic vs high-intensity minutes. By pre-computing
-- zone sample counts in the materialized view, the healthspan query becomes a simple
-- SUM over activity_summary — no metric_stream scan at query time.
--
-- Zone threshold uses the Karvonen (HR reserve) method:
--   threshold = resting_hr + (max_hr - resting_hr) * 0.8
-- where resting_hr is the user's latest value and max_hr is from their profile.
-- Activities for users without max_hr or resting_hr get NULL zone columns.

set lock_timeout = '1s';
set statement_timeout = '300s';

DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary;

--> statement-breakpoint

CREATE MATERIALIZED VIEW fitness.activity_summary AS
WITH altitude_deltas AS (
  SELECT
    ms.activity_id,
    ms.altitude,
    LAG(ms.altitude) OVER (PARTITION BY ms.activity_id ORDER BY ms.recorded_at) AS prev_altitude
  FROM fitness.metric_stream ms
  WHERE ms.activity_id IS NOT NULL
    AND ms.altitude IS NOT NULL
),
elevation_per_activity AS (
  SELECT
    activity_id,
    SUM(CASE WHEN altitude - prev_altitude > 0 THEN altitude - prev_altitude ELSE 0 END)::REAL AS elevation_gain_m,
    SUM(CASE WHEN altitude - prev_altitude < 0 THEN ABS(altitude - prev_altitude) ELSE 0 END)::REAL AS elevation_loss_m
  FROM altitude_deltas
  WHERE prev_altitude IS NOT NULL
  GROUP BY activity_id
),
gps_deltas AS (
  SELECT
    ms.activity_id,
    ms.lat,
    ms.lng,
    LAG(ms.lat) OVER (PARTITION BY ms.activity_id ORDER BY ms.recorded_at) AS prev_lat,
    LAG(ms.lng) OVER (PARTITION BY ms.activity_id ORDER BY ms.recorded_at) AS prev_lng
  FROM fitness.metric_stream ms
  WHERE ms.activity_id IS NOT NULL
    AND ms.lat IS NOT NULL
    AND ms.lng IS NOT NULL
),
distance_per_activity AS (
  SELECT
    activity_id,
    SUM(
      2 * 6371000 * ASIN(SQRT(
        POWER(SIN(RADIANS(lat - prev_lat) / 2), 2) +
        COS(RADIANS(prev_lat)) * COS(RADIANS(lat)) *
        POWER(SIN(RADIANS(lng - prev_lng) / 2), 2)
      ))
    )::REAL AS total_distance
  FROM gps_deltas
  WHERE prev_lat IS NOT NULL
  GROUP BY activity_id
),
-- Per-user HR zone threshold using Karvonen (HR reserve) method.
-- Uses latest resting HR — good enough since RHR changes slowly.
user_hr_threshold AS (
  SELECT
    up.id AS user_id,
    (rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8)::REAL AS threshold
  FROM fitness.user_profile up
  JOIN LATERAL (
    SELECT dm.resting_hr
    FROM fitness.v_daily_metrics dm
    WHERE dm.user_id = up.id
      AND dm.resting_hr IS NOT NULL
    ORDER BY dm.date DESC
    LIMIT 1
  ) rhr ON true
  WHERE up.max_hr IS NOT NULL
)
SELECT
  ms.activity_id,
  ms.user_id,
  a.activity_type,
  a.started_at,
  a.ended_at,
  a.name,
  -- Heart rate
  AVG(ms.heart_rate)::REAL           AS avg_hr,
  MAX(ms.heart_rate)::SMALLINT       AS max_hr,
  MIN(ms.heart_rate)::SMALLINT       AS min_hr,
  -- Power
  AVG(ms.power) FILTER (WHERE ms.power > 0)::REAL    AS avg_power,
  MAX(ms.power) FILTER (WHERE ms.power > 0)::SMALLINT AS max_power,
  -- Speed / Distance / Cadence — null for indoor rides (simulated, not meaningful)
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN NULL
       ELSE AVG(ms.speed)::REAL END                AS avg_speed,
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN NULL
       ELSE MAX(ms.speed)::REAL END                AS max_speed,
  AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::REAL AS avg_cadence,
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN 0::REAL
       ELSE COALESCE(d.total_distance, 0)::REAL END AS total_distance,
  -- Elevation
  MAX(ms.altitude)::REAL             AS max_altitude,
  MIN(ms.altitude) FILTER (WHERE ms.altitude IS NOT NULL)::REAL AS min_altitude,
  COALESCE(e.elevation_gain_m, 0)::REAL AS elevation_gain_m,
  COALESCE(e.elevation_loss_m, 0)::REAL AS elevation_loss_m,
  -- Pedal dynamics
  AVG(ms.left_right_balance)::REAL         AS avg_left_balance,
  AVG(ms.left_torque_effectiveness)::REAL  AS avg_left_torque_eff,
  AVG(ms.right_torque_effectiveness)::REAL AS avg_right_torque_eff,
  AVG(ms.left_pedal_smoothness)::REAL      AS avg_left_pedal_smooth,
  AVG(ms.right_pedal_smoothness)::REAL     AS avg_right_pedal_smooth,
  -- Running dynamics
  AVG(ms.stance_time)::REAL          AS avg_stance_time,
  AVG(ms.vertical_oscillation)::REAL AS avg_vertical_osc,
  AVG(ms.ground_contact_time)::REAL  AS avg_ground_contact_time,
  AVG(ms.stride_length)::REAL        AS avg_stride_length,
  -- Counts
  COUNT(*)::INT                      AS sample_count,
  COUNT(ms.heart_rate)::INT          AS hr_sample_count,
  COUNT(ms.power) FILTER (WHERE ms.power > 0)::INT AS power_sample_count,
  -- Duration (first/last sample timestamps)
  MIN(ms.recorded_at)                AS first_sample_at,
  MAX(ms.recorded_at)                AS last_sample_at,
  -- HR Zone Time (aerobic = below 80% HRR, high intensity = at or above)
  -- Uses uniform sample weight: duration / hr_sample_count per sample.
  -- NULL when user has no max_hr or resting_hr configured.
  CASE WHEN uht.threshold IS NOT NULL AND COUNT(ms.heart_rate) > 0 AND a.ended_at IS NOT NULL
    THEN (COUNT(ms.heart_rate) FILTER (WHERE ms.heart_rate < uht.threshold)::REAL
          / COUNT(ms.heart_rate)::REAL
          * EXTRACT(EPOCH FROM (a.ended_at - a.started_at))
          / 60.0)::REAL
    ELSE NULL
  END AS aerobic_minutes,
  CASE WHEN uht.threshold IS NOT NULL AND COUNT(ms.heart_rate) > 0 AND a.ended_at IS NOT NULL
    THEN (COUNT(ms.heart_rate) FILTER (WHERE ms.heart_rate >= uht.threshold)::REAL
          / COUNT(ms.heart_rate)::REAL
          * EXTRACT(EPOCH FROM (a.ended_at - a.started_at))
          / 60.0)::REAL
    ELSE NULL
  END AS high_intensity_minutes
FROM fitness.metric_stream ms
JOIN fitness.v_activity a ON a.id = ms.activity_id
LEFT JOIN elevation_per_activity e ON e.activity_id = ms.activity_id
LEFT JOIN distance_per_activity d ON d.activity_id = ms.activity_id
LEFT JOIN user_hr_threshold uht ON uht.user_id = ms.user_id
WHERE ms.activity_id IS NOT NULL
GROUP BY ms.activity_id, ms.user_id, a.activity_type, a.started_at, a.ended_at, a.name,
         e.elevation_gain_m, e.elevation_loss_m, d.total_distance, uht.threshold;

--> statement-breakpoint

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS activity_summary_pk ON fitness.activity_summary (activity_id);

--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);
