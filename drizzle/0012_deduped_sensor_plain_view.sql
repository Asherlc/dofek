-- Replace the expensive materialized Postgres view with a plain view.
-- Behavior is preserved while removing refresh cost and concurrent materialized-view locks.

-- Drop the materialized view with CASCADE since activity_summary depends on it.
-- Recreate activity_summary from the canonical _views/ definition after the drop.
DROP MATERIALIZED VIEW IF EXISTS fitness.deduped_sensor CASCADE;
DROP INDEX IF EXISTS fitness.deduped_sensor_pk;
DROP INDEX IF EXISTS fitness.deduped_sensor_activity_time_idx;

--> statement-breakpoint

-- Recreate activity_summary from its canonical definition (it was dropped by CASCADE above).
-- The definition is maintained in drizzle/_views/06_activity_summary.sql.
CREATE VIEW fitness.activity_summary AS
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
      (6371000 * acos(
        LEAST(1.0,
          sin(radians(lat)) * sin(radians(prev_lat)) +
          cos(radians(lat)) * cos(radians(prev_lat)) *
          cos(radians(lng) - radians(prev_lng))
        )
      ))::NUMERIC
    ) AS distance_m
  FROM gps_deltas
  WHERE prev_lat IS NOT NULL
  GROUP BY activity_id
),
hr_zones AS (
  SELECT
    activity_id,
    MAX(CASE WHEN scalar BETWEEN 0 AND 113 THEN 1 ELSE 0 END) AS zone1_s,
    MAX(CASE WHEN scalar BETWEEN 114 AND 135 THEN 1 ELSE 0 END) AS zone2_s,
    MAX(CASE WHEN scalar BETWEEN 136 AND 156 THEN 1 ELSE 0 END) AS zone3_s,
    MAX(CASE WHEN scalar BETWEEN 157 AND 171 THEN 1 ELSE 0 END) AS zone4_s,
    MAX(CASE WHEN scalar >= 172 THEN 1 ELSE 0 END) AS zone5_s
  FROM fitness.deduped_sensor
  WHERE channel = 'heart_rate'
  GROUP BY activity_id
),
power_zones AS (
  SELECT
    activity_id,
    MAX(CASE WHEN scalar BETWEEN 0 AND 143 THEN 1 ELSE 0 END) AS zone1_w,
    MAX(CASE WHEN scalar BETWEEN 144 AND 208 THEN 1 ELSE 0 END) AS zone2_w,
    MAX(CASE WHEN scalar BETWEEN 209 AND 278 THEN 1 ELSE 0 END) AS zone3_w,
    MAX(CASE WHEN scalar BETWEEN 279 AND 333 THEN 1 ELSE 0 END) AS zone4_w,
    MAX(CASE WHEN scalar >= 334 THEN 1 ELSE 0 END) AS zone5_w
  FROM fitness.deduped_sensor
  WHERE channel = 'power'
  GROUP BY activity_id
)
SELECT
  a.id AS activity_id,
  a.user_id,
  a.started_at,
  a.ended_at,
  a.provider_id,
  a.source_name,
  a.type,
  a.primary_type,
  a.distance_m,
  a.moving_time_s,
  a.elapsed_time_s,
  a.avg_heart_rate,
  a.max_heart_rate,
  a.avg_power,
  a.avg_cadence,
  a.avg_speed,
  a.calories_kcal,
  a.avg_vertical_oscillation,
  a.avg_vertical_ratio,
  a.avg_ground_contact_time,
  a.avg_heart_rate_variability,
  a.avg_step_length,
  COALESCE(elevation_gain_m, 0) AS elevation_gain_m,
  COALESCE(elevation_loss_m, 0) AS elevation_loss_m,
  COALESCE(distance_m, a.distance_m) AS computed_distance_m,
  COALESCE(zone1_s, 0) AS has_zone1_hr,
  COALESCE(zone2_s, 0) AS has_zone2_hr,
  COALESCE(zone3_s, 0) AS has_zone3_hr,
  COALESCE(zone4_s, 0) AS has_zone4_hr,
  COALESCE(zone5_s, 0) AS has_zone5_hr,
  COALESCE(zone1_w, 0) AS has_zone1_power,
  COALESCE(zone2_w, 0) AS has_zone2_power,
  COALESCE(zone3_w, 0) AS has_zone3_power,
  COALESCE(zone4_w, 0) AS has_zone4_power,
  COALESCE(zone5_w, 0) AS has_zone5_power
FROM fitness.v_activity a
LEFT JOIN elevation_per_activity e ON e.activity_id = a.id
LEFT JOIN distance_per_activity d ON d.activity_id = a.id
LEFT JOIN hr_zones hr ON hr.activity_id = a.id
LEFT JOIN power_zones pz ON pz.activity_id = a.id
ORDER BY a.started_at DESC;

--> statement-breakpoint

CREATE VIEW fitness.deduped_sensor AS

-- Step 0: Flatten v_activity to get canonical_id -> member_id mapping
WITH canonical_activities AS (
  SELECT
    a.id AS canonical_id,
    a.user_id,
    a.started_at,
    a.ended_at,
    a.member_activity_ids
  FROM fitness.v_activity a
),
activity_members AS (
  SELECT a.id AS canonical_id, a.user_id, unnest(a.member_activity_ids) AS member_id
  FROM fitness.v_activity a
),

-- Step 1: For activity-linked samples, pick the best provider per (canonical_activity, channel)
linked_best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT am.canonical_id, ms.channel, ms.provider_id, COUNT(*) AS sample_count
    FROM fitness.metric_stream ms
    JOIN activity_members am ON ms.activity_id = am.member_id
    WHERE ms.activity_id IS NOT NULL
    GROUP BY am.canonical_id, ms.channel, ms.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 2: Compute fallback end bound per canonical activity.
-- For open-ended activities (ended_at IS NULL), fallback is capped at the last
-- linked sample timestamp to avoid an unbounded ambient window.
linked_sample_bounds AS (
  SELECT am.canonical_id, MAX(ms.recorded_at) AS last_linked_sample_at
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  WHERE ms.activity_id IS NOT NULL
  GROUP BY am.canonical_id
),
fallback_windows AS (
  SELECT
    ca.canonical_id,
    ca.user_id,
    ca.started_at,
    COALESCE(ca.ended_at, lsb.last_linked_sample_at) AS fallback_ended_at
  FROM canonical_activities ca
  LEFT JOIN linked_sample_bounds lsb ON lsb.canonical_id = ca.canonical_id
),

-- Step 3: For ambient samples (activity_id IS NULL), only consider channels that
-- have zero activity-linked samples for the canonical activity.
ambient_best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT fw.canonical_id, ms.channel, ms.provider_id, COUNT(*) AS sample_count
    FROM fitness.metric_stream ms
    JOIN fallback_windows fw
      ON fw.user_id = ms.user_id
    LEFT JOIN linked_best_source lbs
      ON lbs.canonical_id = fw.canonical_id
      AND lbs.channel = ms.channel
    WHERE ms.activity_id IS NULL
      AND fw.fallback_ended_at IS NOT NULL
      AND ms.recorded_at >= fw.started_at
      AND ms.recorded_at <= fw.fallback_ended_at
      AND lbs.canonical_id IS NULL
    GROUP BY fw.canonical_id, ms.channel, ms.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 4: Linked samples from the winning provider per channel.
linked_samples AS (
  SELECT
    am.canonical_id AS activity_id,
    am.user_id,
    ms.recorded_at,
    ms.channel,
    MAX(ms.scalar) AS scalar
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  JOIN linked_best_source lbs
    ON am.canonical_id = lbs.canonical_id
    AND ms.channel = lbs.channel
    AND ms.provider_id = lbs.provider_id
  WHERE ms.activity_id IS NOT NULL
    AND ms.scalar IS NOT NULL
  GROUP BY am.canonical_id, am.user_id, ms.recorded_at, ms.channel
),

-- Step 5: Ambient fallback samples from the winning ambient provider per channel.
ambient_samples AS (
  SELECT
    fw.canonical_id AS activity_id,
    fw.user_id,
    ms.recorded_at,
    ms.channel,
    MAX(ms.scalar) AS scalar
  FROM fitness.metric_stream ms
  JOIN fallback_windows fw
    ON fw.user_id = ms.user_id
  JOIN ambient_best_source abs
    ON fw.canonical_id = abs.canonical_id
    AND ms.channel = abs.channel
    AND ms.provider_id = abs.provider_id
  WHERE ms.activity_id IS NULL
    AND fw.fallback_ended_at IS NOT NULL
    AND ms.recorded_at >= fw.started_at
    AND ms.recorded_at <= fw.fallback_ended_at
    AND ms.scalar IS NOT NULL
  GROUP BY fw.canonical_id, fw.user_id, ms.recorded_at, ms.channel
)

-- Step 6: Union linked samples with ambient fallback samples.
SELECT
  ls.activity_id,
  ls.user_id,
  ls.recorded_at,
  ls.channel,
  ls.scalar
FROM linked_samples ls
UNION ALL
SELECT
  asmp.activity_id,
  asmp.user_id,
  asmp.recorded_at,
  asmp.channel,
  asmp.scalar
FROM ambient_samples asmp;
