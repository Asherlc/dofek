-- Canonical definition of the fitness.activity_summary materialized view.
-- This view depends on fitness.v_activity — it must be created after 01_v_activity.sql.
--
-- Reads from fitness.sensor_sample with built-in dedup:
-- For each (activity_id, channel), picks the provider_id with the most samples.
-- This ensures BLE data (50Hz) is preferred over API data (1Hz) automatically.

CREATE MATERIALIZED VIEW fitness.activity_summary AS

-- Step 1: For each (activity, channel), pick the provider with the most samples
WITH best_source AS (
  SELECT DISTINCT ON (activity_id, channel)
    activity_id, channel, provider_id
  FROM (
    SELECT activity_id, channel, provider_id, COUNT(*) AS sample_count
    FROM fitness.sensor_sample
    WHERE activity_id IS NOT NULL
    GROUP BY activity_id, channel, provider_id
  ) counts
  ORDER BY activity_id, channel, sample_count DESC
),

-- Step 2: Deduplicated scalar samples (only the winning provider per channel)
deduped AS (
  SELECT ss.activity_id, ss.user_id, ss.recorded_at, ss.channel, ss.scalar
  FROM fitness.sensor_sample ss
  JOIN best_source bs
    ON ss.activity_id = bs.activity_id
    AND ss.channel = bs.channel
    AND ss.provider_id = bs.provider_id
  WHERE ss.activity_id IS NOT NULL
    AND ss.scalar IS NOT NULL
),

-- Step 3: Elevation gain/loss from altitude channel (window function on ordered data)
altitude_deltas AS (
  SELECT
    activity_id,
    scalar AS altitude,
    LAG(scalar) OVER (PARTITION BY activity_id ORDER BY recorded_at) AS prev_altitude
  FROM deduped
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

-- Step 4: GPS distance from lat/lng channels (need to join lat+lng by timestamp)
gps_points AS (
  SELECT
    lat_s.activity_id,
    lat_s.recorded_at,
    lat_s.scalar AS lat,
    lng_s.scalar AS lng
  FROM deduped lat_s
  JOIN deduped lng_s
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

-- Step 5: Per-activity, per-channel aggregates (pivoted from narrow to wide)
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
    -- Counts (total rows regardless of channel for sample_count)
    COUNT(*) FILTER (WHERE channel = 'heart_rate')::INT               AS hr_sample_count,
    COUNT(*) FILTER (WHERE channel = 'power' AND scalar > 0)::INT     AS power_sample_count,
    -- Duration
    MIN(recorded_at)                AS first_sample_at,
    MAX(recorded_at)                AS last_sample_at
  FROM deduped
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
  (ca.hr_sample_count + ca.power_sample_count)::INT AS sample_count,
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
