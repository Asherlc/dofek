-- Canonical definition of the fitness.activity_summary materialized view.
-- This view depends on fitness.v_activity — it must be created after 01_v_activity.sql.
--
-- Reads from fitness.sensor_sample with built-in dedup:
-- For each (canonical_activity, channel), picks the provider_id with the most samples
-- across all member activities in a merge group.
-- This ensures BLE data (50Hz) is preferred over API data (1Hz) automatically,
-- and cross-provider HR data (e.g. Apple Watch HR for a Peloton ride) is included.

CREATE MATERIALIZED VIEW fitness.activity_summary AS

-- Step 0: Flatten v_activity to get canonical_id → member_id mapping
WITH activity_members AS (
  SELECT a.id AS canonical_id, a.user_id, unnest(a.member_activity_ids) AS member_id
  FROM fitness.v_activity a
),

-- Step 1: For each (canonical_activity, channel), pick the provider with the most samples
best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT am.canonical_id, ss.channel, ss.provider_id, COUNT(*) AS sample_count
    FROM fitness.sensor_sample ss
    JOIN activity_members am ON ss.activity_id = am.member_id
    WHERE ss.activity_id IS NOT NULL
    GROUP BY am.canonical_id, ss.channel, ss.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 2: Deduplicated scalar samples (only the winning provider per channel)
sensor_deduped AS (
  SELECT am.canonical_id AS activity_id, am.user_id, ss.recorded_at, ss.channel, ss.scalar
  FROM fitness.sensor_sample ss
  JOIN activity_members am ON ss.activity_id = am.member_id
  JOIN best_source bs
    ON am.canonical_id = bs.canonical_id
    AND ss.channel = bs.channel
    AND ss.provider_id = bs.provider_id
  WHERE ss.activity_id IS NOT NULL
    AND ss.scalar IS NOT NULL
),

-- Step 2b: During sensor backfill/cutover, keep activity_summary populated by
-- falling back to legacy metric_stream rows for activities that have not yet
-- produced any sensor_sample rows.
legacy_fallback AS (
  SELECT
    am.canonical_id AS activity_id,
    am.user_id,
    ms.recorded_at,
    expanded.channel,
    expanded.scalar
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  CROSS JOIN LATERAL (
    VALUES
      ('heart_rate', ms.heart_rate::REAL),
      ('power', ms.power::REAL),
      ('speed', ms.speed),
      ('cadence', ms.cadence::REAL),
      ('altitude', ms.altitude),
      ('lat', ms.lat),
      ('lng', ms.lng),
      ('left_right_balance', ms.left_right_balance),
      ('left_torque_effectiveness', ms.left_torque_effectiveness),
      ('right_torque_effectiveness', ms.right_torque_effectiveness),
      ('left_pedal_smoothness', ms.left_pedal_smoothness),
      ('right_pedal_smoothness', ms.right_pedal_smoothness),
      ('stance_time', ms.stance_time),
      ('vertical_oscillation', ms.vertical_oscillation),
      ('ground_contact_time', ms.ground_contact_time),
      ('stride_length', ms.stride_length)
  ) AS expanded(channel, scalar)
  WHERE ms.activity_id IS NOT NULL
    AND expanded.scalar IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM fitness.sensor_sample ss
      JOIN activity_members am2 ON ss.activity_id = am2.member_id
      WHERE am2.canonical_id = am.canonical_id
    )
),
deduped AS (
  SELECT * FROM sensor_deduped
  UNION ALL
  SELECT * FROM legacy_fallback
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
    -- Counts
    COUNT(*)::INT                                                      AS sample_count,
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
