-- Canonical definition of the fitness.activity_summary materialized view.
-- This view depends on fitness.deduped_sensor — it must be created after 05_deduped_sensor.sql.
--
-- Reads from fitness.deduped_sensor which already handles best-source dedup
-- and legacy metric_stream fallback. This view only does aggregation.

CREATE MATERIALIZED VIEW fitness.activity_summary AS

-- Step 1: Elevation gain/loss from altitude channel (window function on ordered data)
WITH altitude_deltas AS (
  SELECT
    activity_id,
    scalar AS altitude,
    LAG(scalar) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_altitude
  FROM fitness.deduped_sensor
  WHERE channel = 'altitude'
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

-- Step 2: GPS distance from lat/lng channels (need to join lat+lng by timestamp)
gps_points AS (
  SELECT
    lat_s.activity_id,
    lat_s.recorded_at,
    lat_s.scalar AS lat,
    lng_s.scalar AS lng
  FROM fitness.deduped_sensor lat_s
  JOIN fitness.deduped_sensor lng_s
    ON lat_s.activity_id = lng_s.activity_id
    AND lat_s.recorded_at = lng_s.recorded_at
    AND lng_s.channel = 'lng'
  WHERE lat_s.channel = 'lat'
),
gps_deltas AS (
  SELECT
    activity_id,
    lat, lng,
    LAG(lat) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_lat,
    LAG(lng) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_lng
  FROM gps_points
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

-- Step 3: Per-activity, per-channel aggregates (pivoted from narrow to wide)
channel_aggs AS (
  SELECT
    activity_id,
    user_id,
    -- Heart rate
    AVG(scalar) FILTER (WHERE channel = 'heart_rate')::REAL           AS avg_hr,
    MAX(scalar) FILTER (WHERE channel = 'heart_rate')::SMALLINT       AS max_hr,
    MIN(scalar) FILTER (WHERE channel = 'heart_rate')::SMALLINT       AS min_hr,
    -- Power
    AVG(scalar) FILTER (WHERE channel = 'power' AND scalar > 0)::REAL    AS avg_power,
    MAX(scalar) FILTER (WHERE channel = 'power' AND scalar > 0)::SMALLINT AS max_power,
    -- Speed
    AVG(scalar) FILTER (WHERE channel = 'speed')::REAL                AS avg_speed_raw,
    MAX(scalar) FILTER (WHERE channel = 'speed')::REAL                AS max_speed_raw,
    -- Cadence
    AVG(scalar) FILTER (WHERE channel = 'cadence' AND scalar > 0)::REAL AS avg_cadence,
    -- Altitude
    MAX(scalar) FILTER (WHERE channel = 'altitude')::REAL             AS max_altitude,
    MIN(scalar) FILTER (WHERE channel = 'altitude')::REAL             AS min_altitude,
    -- Pedal dynamics
    AVG(scalar) FILTER (WHERE channel = 'left_right_balance')::REAL         AS avg_left_balance,
    AVG(scalar) FILTER (WHERE channel = 'left_torque_effectiveness')::REAL  AS avg_left_torque_eff,
    AVG(scalar) FILTER (WHERE channel = 'right_torque_effectiveness')::REAL AS avg_right_torque_eff,
    AVG(scalar) FILTER (WHERE channel = 'left_pedal_smoothness')::REAL      AS avg_left_pedal_smooth,
    AVG(scalar) FILTER (WHERE channel = 'right_pedal_smoothness')::REAL     AS avg_right_pedal_smooth,
    -- Running dynamics
    AVG(scalar) FILTER (WHERE channel = 'stance_time')::REAL          AS avg_stance_time,
    AVG(scalar) FILTER (WHERE channel = 'vertical_oscillation')::REAL AS avg_vertical_osc,
    AVG(scalar) FILTER (WHERE channel = 'ground_contact_time')::REAL  AS avg_ground_contact_time,
    AVG(scalar) FILTER (WHERE channel = 'stride_length')::REAL        AS avg_stride_length,
    -- Counts
    COUNT(*)::INT                                                      AS sample_count,
    COUNT(*) FILTER (WHERE channel = 'heart_rate')::INT               AS hr_sample_count,
    COUNT(*) FILTER (WHERE channel = 'power' AND scalar > 0)::INT     AS power_sample_count,
    -- Duration
    MIN(recorded_at)                AS first_sample_at,
    MAX(recorded_at)                AS last_sample_at
  FROM fitness.deduped_sensor
  GROUP BY activity_id, user_id
)

SELECT
  ca.activity_id,
  ca.user_id,
  a.activity_type,
  a.started_at,
  a.ended_at,
  a.name,
  -- Heart rate
  ca.avg_hr,
  ca.max_hr,
  ca.min_hr,
  -- Power
  ca.avg_power,
  ca.max_power,
  -- Speed / Distance / Cadence — null for indoor rides
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN NULL
       ELSE ca.avg_speed_raw END                AS avg_speed,
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN NULL
       ELSE ca.max_speed_raw END                AS max_speed,
  ca.avg_cadence,
  CASE WHEN a.activity_type IN ('indoor_cycling', 'virtual_cycling') THEN 0::REAL
       ELSE COALESCE(d.total_distance, 0)::REAL END AS total_distance,
  -- Elevation
  ca.max_altitude,
  ca.min_altitude,
  COALESCE(e.elevation_gain_m, 0)::REAL AS elevation_gain_m,
  COALESCE(e.elevation_loss_m, 0)::REAL AS elevation_loss_m,
  -- Pedal dynamics
  ca.avg_left_balance,
  ca.avg_left_torque_eff,
  ca.avg_right_torque_eff,
  ca.avg_left_pedal_smooth,
  ca.avg_right_pedal_smooth,
  -- Running dynamics
  ca.avg_stance_time,
  ca.avg_vertical_osc,
  ca.avg_ground_contact_time,
  ca.avg_stride_length,
  -- Counts
  ca.sample_count,
  ca.hr_sample_count,
  ca.power_sample_count,
  -- Duration
  ca.first_sample_at,
  ca.last_sample_at
FROM channel_aggs ca
JOIN fitness.v_activity a ON a.id = ca.activity_id
LEFT JOIN elevation_per_activity e ON e.activity_id = ca.activity_id
LEFT JOIN distance_per_activity d ON d.activity_id = ca.activity_id;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS activity_summary_pk ON fitness.activity_summary (activity_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);
