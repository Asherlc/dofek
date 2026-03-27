-- Add timezone and strava_id columns to the activity table.
-- timezone: IANA timezone name (e.g. "America/New_York") to preserve local time-of-day.
-- strava_id: cross-provider link to Strava activity (matches external_id where provider_id = 'strava').

SET lock_timeout = '4s';
SET statement_timeout = '60s';

ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS strava_id TEXT;

--> statement-breakpoint

-- Backfill timezone from raw JSONB for existing Peloton activities
UPDATE fitness.activity
  SET timezone = raw->>'timezone'
  WHERE provider_id = 'peloton'
    AND raw->>'timezone' IS NOT NULL
    AND timezone IS NULL;

--> statement-breakpoint

-- Rebuild v_activity to include timezone in the dedup merge
DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity CASCADE;

CREATE MATERIALIZED VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio
  FROM fitness.activity a
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = a.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.user_id = r2.user_id
    AND r1.id < r2.id
    AND EXTRACT(EPOCH FROM (
      LEAST(COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
            COALESCE(r2.ended_at, r2.started_at + interval '1 hour'))
      - GREATEST(r1.started_at, r2.started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
               COALESCE(r2.ended_at, r2.started_at + interval '1 hour'))
      - LEAST(r1.started_at, r2.started_at)
    )), 0) > 0.8
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(activity_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.activity_id = e.a
),
final_groups AS (
  SELECT activity_id, MIN(group_id) AS group_id
  FROM clusters
  GROUP BY activity_id
),
best_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.activity_type,
    r.started_at,
    r.ended_at,
    r.source_name,
    r.prio
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.activity_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
),
merged AS (
  SELECT
    b.canonical_id,
    b.provider_id,
    b.user_id,
    b.activity_type,
    b.started_at,
    b.ended_at,
    b.source_name,
    (SELECT r.name FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.name IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS name,
    (SELECT r.notes FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.notes IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS notes,
    (SELECT r.timezone FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.timezone IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS timezone,
    (SELECT jsonb_object_agg(key, value)
     FROM (
       SELECT key, value, ROW_NUMBER() OVER (PARTITION BY key ORDER BY r.prio ASC) AS rn
       FROM final_groups fg2
       JOIN ranked r ON r.id = fg2.activity_id,
       LATERAL jsonb_each(COALESCE(r.raw, '{}'::jsonb))
       WHERE fg2.group_id = b.group_id
     ) sub WHERE rn = 1
    ) AS raw,
    (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
     FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id) AS source_providers
  FROM best_per_group b
)
SELECT
  m.canonical_id AS id,
  m.provider_id,
  m.user_id,
  m.canonical_id AS primary_activity_id,
  m.activity_type,
  m.started_at,
  m.ended_at,
  m.source_name,
  m.name,
  m.notes,
  m.timezone,
  m.raw,
  m.source_providers
FROM merged m
ORDER BY m.started_at DESC;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS v_activity_id_idx ON fitness.v_activity (id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS v_activity_time_idx ON fitness.v_activity (started_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS v_activity_user_time_idx ON fitness.v_activity (user_id, started_at DESC);

--> statement-breakpoint

-- Recreate activity_summary (depends on v_activity)
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
  MAX(ms.recorded_at)                AS last_sample_at
FROM fitness.metric_stream ms
JOIN fitness.v_activity a ON a.id = ms.activity_id
LEFT JOIN elevation_per_activity e ON e.activity_id = ms.activity_id
LEFT JOIN distance_per_activity d ON d.activity_id = ms.activity_id
WHERE ms.activity_id IS NOT NULL
GROUP BY ms.activity_id, ms.user_id, a.activity_type, a.started_at, a.ended_at, a.name,
         e.elevation_gain_m, e.elevation_loss_m, d.total_distance;

--> statement-breakpoint

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS activity_summary_pk ON fitness.activity_summary (activity_id);

--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);
