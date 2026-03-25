-- Convert activity_type from text to a Postgres enum.
--
-- Adds cycling subtypes (road_cycling, mountain_biking, gravel_cycling, etc.)
-- as first-class enum values. Also normalizes legacy space-separated values
-- to underscore format before the conversion.

-- Step 1: Normalize space-separated values to underscores
UPDATE fitness.activity
SET activity_type = REPLACE(activity_type, ' ', '_')
WHERE activity_type LIKE '% %';

-- Step 2: Create the enum type with all canonical activity types
CREATE TYPE fitness.activity_type AS ENUM (
  -- Cycling subtypes
  'cycling',
  'road_cycling',
  'mountain_biking',
  'gravel_cycling',
  'indoor_cycling',
  'virtual_cycling',
  'e_bike_cycling',
  'cyclocross',
  'track_cycling',
  'bmx',
  -- Endurance
  'running',
  'trail_running',
  'swimming',
  'open_water_swimming',
  'walking',
  'hiking',
  -- Strength / gym
  'strength',
  'strength_training',
  'functional_strength',
  'gym',
  -- Mind / body
  'yoga',
  'pilates',
  'tai_chi',
  'mind_and_body',
  'meditation',
  'breathwork',
  'stretching',
  'flexibility',
  'barre',
  -- Cardio / HIIT
  'elliptical',
  'rowing',
  'cardio',
  'hiit',
  'mixed_cardio',
  'mixed_metabolic_cardio',
  'stair_climbing',
  'stairmaster',
  'stairs',
  'step_training',
  'jump_rope',
  'fitness_gaming',
  -- Cross training
  'cross_training',
  'bootcamp',
  'circuit_training',
  'functional_fitness',
  'core',
  'core_training',
  'boxing',
  'kickboxing',
  'martial_arts',
  'group_exercise',
  -- Winter sports
  'skiing',
  'cross_country_skiing',
  'downhill_skiing',
  'snowboarding',
  'snow_sports',
  'snowshoeing',
  'skating',
  -- Water sports
  'surfing',
  'kayaking',
  'sailing',
  'paddle_sports',
  'paddleboarding',
  'paddling',
  'water_fitness',
  'water_polo',
  'water_sports',
  'aqua_fitness',
  'underwater_diving',
  'diving',
  'snorkeling',
  -- Racquet sports
  'tennis',
  'table_tennis',
  'squash',
  'racquetball',
  'badminton',
  'pickleball',
  'padel',
  'paddle_racquet',
  -- Team sports
  'basketball',
  'soccer',
  'football',
  'american_football',
  'australian_football',
  'rugby',
  'hockey',
  'ice_hockey',
  'lacrosse',
  'baseball',
  'softball',
  'volleyball',
  'cricket',
  'handball',
  -- Other sports
  'golf',
  'disc_golf',
  'climbing',
  'rock_climbing',
  'dance',
  'dancing',
  'cardio_dance',
  'social_dance',
  'triathlon',
  'multisport',
  'hand_cycling',
  'wheelchair_walk',
  'wheelchair_run',
  'disc_sports',
  -- Outdoor / recreation
  'equestrian',
  'fencing',
  'fishing',
  'hunting',
  'gymnastics',
  'archery',
  'bowling',
  'curling',
  'wrestling',
  'track_and_field',
  'play',
  'navigation',
  'geocaching',
  -- Air sports
  'skydiving',
  'paragliding',
  -- Activity lifecycle
  'preparation_and_recovery',
  'cooldown',
  'transition',
  -- Catch-all
  'other'
);

-- Step 3: Map any remaining non-enum values to 'other'
UPDATE fitness.activity
SET activity_type = 'other'
WHERE activity_type NOT IN (
  'cycling', 'road_cycling', 'mountain_biking', 'gravel_cycling',
  'indoor_cycling', 'virtual_cycling', 'e_bike_cycling', 'cyclocross',
  'track_cycling', 'bmx', 'running', 'trail_running', 'swimming',
  'open_water_swimming', 'walking', 'hiking', 'strength', 'strength_training',
  'functional_strength', 'gym', 'yoga', 'pilates', 'tai_chi', 'mind_and_body',
  'meditation', 'breathwork', 'stretching', 'flexibility', 'barre',
  'elliptical', 'rowing', 'cardio', 'hiit', 'mixed_cardio',
  'mixed_metabolic_cardio', 'stair_climbing', 'stairmaster', 'stairs',
  'step_training', 'jump_rope', 'fitness_gaming', 'cross_training',
  'bootcamp', 'circuit_training', 'functional_fitness', 'core', 'core_training',
  'boxing', 'kickboxing', 'martial_arts', 'group_exercise', 'skiing',
  'cross_country_skiing', 'downhill_skiing', 'snowboarding', 'snow_sports',
  'snowshoeing', 'skating', 'surfing', 'kayaking', 'sailing', 'paddle_sports',
  'paddleboarding', 'paddling', 'water_fitness', 'water_polo', 'water_sports',
  'aqua_fitness', 'underwater_diving', 'diving', 'snorkeling', 'tennis',
  'table_tennis', 'squash', 'racquetball', 'badminton', 'pickleball', 'padel',
  'paddle_racquet', 'basketball', 'soccer', 'football', 'american_football',
  'australian_football', 'rugby', 'hockey', 'ice_hockey', 'lacrosse',
  'baseball', 'softball', 'volleyball', 'cricket', 'handball', 'golf',
  'disc_golf', 'climbing', 'rock_climbing', 'dance', 'dancing', 'cardio_dance',
  'social_dance', 'triathlon', 'multisport', 'hand_cycling', 'wheelchair_walk',
  'wheelchair_run', 'disc_sports', 'equestrian', 'fencing', 'fishing',
  'hunting', 'gymnastics', 'archery', 'bowling', 'curling', 'wrestling',
  'track_and_field', 'play', 'navigation', 'geocaching', 'skydiving',
  'paragliding', 'preparation_and_recovery', 'cooldown', 'transition', 'other'
);

--> statement-breakpoint

-- Step 4: Drop materialized views that depend on the activity_type column
DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity CASCADE;

--> statement-breakpoint

-- Step 5: Convert the column from text to enum
ALTER TABLE fitness.activity
  ALTER COLUMN activity_type TYPE fitness.activity_type
  USING activity_type::fitness.activity_type;

--> statement-breakpoint

-- Step 6: Recreate v_activity materialized view
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
  m.raw,
  m.source_providers
FROM merged m
ORDER BY m.started_at DESC;

CREATE UNIQUE INDEX v_activity_id_idx ON fitness.v_activity (id);
CREATE INDEX v_activity_time_idx ON fitness.v_activity (started_at DESC);
CREATE INDEX v_activity_user_time_idx ON fitness.v_activity (user_id, started_at DESC);

--> statement-breakpoint

-- Step 7: Recreate activity_summary materialized view
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
  -- Speed / Distance / Cadence
  AVG(ms.speed)::REAL                AS avg_speed,
  MAX(ms.speed)::REAL                AS max_speed,
  AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::REAL AS avg_cadence,
  COALESCE(d.total_distance, 0)::REAL AS total_distance,
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

CREATE UNIQUE INDEX activity_summary_pk ON fitness.activity_summary (activity_id);
CREATE INDEX activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);
