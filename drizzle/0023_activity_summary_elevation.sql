-- ============================================================
-- Migration 0023: Add elevation_gain / elevation_loss to activity_summary
-- ============================================================
-- Elevation gain/loss requires LAG() over consecutive altitude samples,
-- which can't be added to a simple GROUP BY. The view is restructured
-- to pre-compute altitude deltas in a CTE, then LEFT JOIN the result.
--
-- This lets hiking/elevation queries read from the rollup view instead
-- of scanning millions of raw metric_stream rows on every request.

-- Drop dependent objects first (activity_summary has indexes)
DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary;

--> statement-breakpoint

-- Recreate with elevation gain/loss columns
CREATE MATERIALIZED VIEW fitness.activity_summary AS
WITH altitude_deltas AS (
  SELECT
    activity_id,
    altitude,
    LAG(altitude) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_altitude
  FROM fitness.metric_stream
  WHERE activity_id IS NOT NULL
    AND altitude IS NOT NULL
),
elevation_per_activity AS (
  SELECT
    activity_id,
    SUM(CASE WHEN altitude > prev_altitude THEN altitude - prev_altitude ELSE 0 END)::REAL AS elevation_gain,
    SUM(CASE WHEN altitude < prev_altitude THEN prev_altitude - altitude ELSE 0 END)::REAL AS elevation_loss
  FROM altitude_deltas
  WHERE prev_altitude IS NOT NULL
  GROUP BY activity_id
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
  -- Speed / Distance / Cadence
  AVG(ms.speed)::REAL                AS avg_speed,
  MAX(ms.speed)::REAL                AS max_speed,
  AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::REAL AS avg_cadence,
  MAX(ms.distance)::REAL             AS total_distance,
  -- Elevation
  MAX(ms.altitude)::REAL             AS max_altitude,
  MIN(ms.altitude) FILTER (WHERE ms.altitude IS NOT NULL)::REAL AS min_altitude,
  e.elevation_gain,
  e.elevation_loss,
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
  MAX(ms.recorded_at)                AS last_sample_at
FROM fitness.metric_stream ms
JOIN fitness.activity a ON a.id = ms.activity_id
LEFT JOIN elevation_per_activity e ON e.activity_id = ms.activity_id
WHERE ms.activity_id IS NOT NULL
GROUP BY ms.activity_id, ms.user_id, a.activity_type, a.started_at, a.ended_at, a.name,
         e.elevation_gain, e.elevation_loss;

--> statement-breakpoint

CREATE UNIQUE INDEX activity_summary_pk ON fitness.activity_summary (activity_id);
CREATE INDEX activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);
