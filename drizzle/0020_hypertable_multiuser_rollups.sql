-- ============================================================
-- Migration 0020: Hypertable + Multi-User + Rollup Views
-- ============================================================
-- 1. user_profile table
-- 2. user_id on all data tables
-- 3. metric_stream as TimescaleDB hypertable
-- 4. activity_summary + activity_hr_zones rollup materialized views
-- 5. Updated dedup views with user_id
--
-- NOTE: Uses IF NOT EXISTS / IF NOT EXISTS throughout to be idempotent
-- in case a previous partial run applied some statements before failing.

-- Enable TimescaleDB extension (required for create_hypertable)
CREATE EXTENSION IF NOT EXISTS timescaledb;

--> statement-breakpoint

-- ============================================================
-- 1. user_profile table
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.user_profile (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  max_hr     SMALLINT,
  resting_hr SMALLINT,
  ftp        SMALLINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a baseline user row for single-user migration path
INSERT INTO fitness.user_profile (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Baseline User')
ON CONFLICT (id) DO NOTHING;

--> statement-breakpoint

-- ============================================================
-- 2. Add user_id to all data tables
-- ============================================================

-- provider: add user_id + update unique constraint
ALTER TABLE fitness.provider
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

CREATE UNIQUE INDEX IF NOT EXISTS provider_user_name_idx ON fitness.provider (user_id, name);

--> statement-breakpoint

-- activity
ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- sleep_session
ALTER TABLE fitness.sleep_session
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- daily_metrics
ALTER TABLE fitness.daily_metrics
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- body_measurement
ALTER TABLE fitness.body_measurement
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- food_entry
ALTER TABLE fitness.food_entry
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- nutrition_daily
ALTER TABLE fitness.nutrition_daily
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- strength_workout
ALTER TABLE fitness.strength_workout
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- lab_result
ALTER TABLE fitness.lab_result
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- health_event
ALTER TABLE fitness.health_event
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- life_events
ALTER TABLE fitness.life_events
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- journal_entry
ALTER TABLE fitness.journal_entry
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- sync_log
ALTER TABLE fitness.sync_log
  ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES fitness.user_profile(id);

--> statement-breakpoint

-- ============================================================
-- 3. Recreate metric_stream as TimescaleDB hypertable
-- ============================================================

CREATE TABLE IF NOT EXISTS fitness.metric_stream (
  recorded_at       TIMESTAMPTZ NOT NULL,
  user_id           UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                    REFERENCES fitness.user_profile(id),
  activity_id       UUID REFERENCES fitness.activity(id) ON DELETE CASCADE,
  provider_id       TEXT NOT NULL REFERENCES fitness.provider(id),
  heart_rate        SMALLINT,
  power             SMALLINT,
  cadence           SMALLINT,
  speed             REAL,
  distance          REAL,
  altitude          REAL,
  temperature       REAL,
  calories          REAL,
  respiratory_rate  REAL,
  spo2              REAL,
  stress            SMALLINT,
  -- GPS
  lat               REAL,
  lng               REAL,
  grade             REAL,
  vertical_speed    REAL,
  gps_accuracy      SMALLINT,
  -- Running dynamics
  vertical_oscillation   REAL,
  stance_time            REAL,
  stance_time_percent    REAL,
  step_length            REAL,
  vertical_ratio         REAL,
  stance_time_balance    REAL,
  ground_contact_time    REAL,
  stride_length          REAL,
  form_power             REAL,
  leg_spring_stiff       REAL,
  air_power              REAL,
  -- Power pedaling dynamics
  left_right_balance           REAL,
  left_torque_effectiveness    REAL,
  right_torque_effectiveness   REAL,
  left_pedal_smoothness        REAL,
  right_pedal_smoothness       REAL,
  combined_pedal_smoothness    REAL,
  accumulated_power            INTEGER,
  -- Medical/Apple Health
  blood_glucose     REAL,
  audio_exposure    REAL,
  skin_temperature  REAL,
  -- Complete raw record
  raw               JSONB
);

--> statement-breakpoint

-- Convert to hypertable: 1-week chunks
-- This is a no-op if already a hypertable (will error, caught by DO block)
DO $$
BEGIN
  PERFORM create_hypertable('fitness.metric_stream', 'recorded_at',
    chunk_time_interval => INTERVAL '1 week',
    migrate_data => false,
    if_not_exists => true
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'create_hypertable skipped: %', SQLERRM;
END;
$$;

--> statement-breakpoint

-- Compression policy: compress chunks older than 2 weeks
DO $$
BEGIN
  ALTER TABLE fitness.metric_stream SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'user_id, activity_id',
    timescaledb.compress_orderby = 'recorded_at ASC'
  );
  PERFORM add_compression_policy('fitness.metric_stream', INTERVAL '2 weeks', if_not_exists => true);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'compression setup skipped: %', SQLERRM;
END;
$$;

--> statement-breakpoint

-- Covering index for activity-based queries
CREATE INDEX IF NOT EXISTS metric_stream_activity_covering_idx
ON fitness.metric_stream (activity_id)
INCLUDE (heart_rate, power, distance, altitude, cadence, recorded_at);

-- User + time index for time-range queries
CREATE INDEX IF NOT EXISTS metric_stream_user_time_idx
ON fitness.metric_stream (user_id, recorded_at DESC);

-- Provider + time index (existing pattern)
CREATE INDEX IF NOT EXISTS metric_stream_provider_time_idx
ON fitness.metric_stream (provider_id, recorded_at);

-- Activity + time index
CREATE INDEX IF NOT EXISTS metric_stream_activity_time_idx
ON fitness.metric_stream (activity_id, recorded_at);

--> statement-breakpoint

-- ============================================================
-- 4. Rollup materialized views
-- ============================================================

-- Drop if exists so we can recreate cleanly
DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary;
DROP MATERIALIZED VIEW IF EXISTS fitness.activity_hr_zones;

--> statement-breakpoint

-- activity_summary: pre-aggregated per-activity stats
CREATE MATERIALIZED VIEW fitness.activity_summary AS
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
WHERE ms.activity_id IS NOT NULL
GROUP BY ms.activity_id, ms.user_id, a.activity_type, a.started_at, a.ended_at, a.name;

CREATE UNIQUE INDEX activity_summary_pk ON fitness.activity_summary (activity_id);
CREATE INDEX activity_summary_user_time ON fitness.activity_summary (user_id, started_at DESC);

--> statement-breakpoint

-- activity_hr_zones: per-activity HR zone distribution
CREATE MATERIALIZED VIEW fitness.activity_hr_zones AS
SELECT
  ms.activity_id,
  ms.user_id,
  -- 5-zone model (% of max_hr from user_profile)
  COUNT(*) FILTER (WHERE ms.heart_rate < up.max_hr * 0.6)::INT  AS zone1_count,
  COUNT(*) FILTER (WHERE ms.heart_rate >= up.max_hr * 0.6 AND ms.heart_rate < up.max_hr * 0.7)::INT AS zone2_count,
  COUNT(*) FILTER (WHERE ms.heart_rate >= up.max_hr * 0.7 AND ms.heart_rate < up.max_hr * 0.8)::INT AS zone3_count,
  COUNT(*) FILTER (WHERE ms.heart_rate >= up.max_hr * 0.8 AND ms.heart_rate < up.max_hr * 0.9)::INT AS zone4_count,
  COUNT(*) FILTER (WHERE ms.heart_rate >= up.max_hr * 0.9)::INT AS zone5_count,
  COUNT(ms.heart_rate)::INT AS total_hr_samples
FROM fitness.metric_stream ms
JOIN fitness.user_profile up ON up.id = ms.user_id
WHERE ms.heart_rate IS NOT NULL
  AND ms.activity_id IS NOT NULL
  AND up.max_hr IS NOT NULL
GROUP BY ms.activity_id, ms.user_id;

CREATE UNIQUE INDEX activity_hr_zones_pk ON fitness.activity_hr_zones (activity_id);
CREATE INDEX activity_hr_zones_user ON fitness.activity_hr_zones (user_id);

--> statement-breakpoint

-- ============================================================
-- 5. Updated dedup views with user_id
-- ============================================================

-- Drop existing dedup views so we can recreate with user_id
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

--> statement-breakpoint

-- v_activity: canonical activities (unchanged logic, just recreated after drop)
CREATE MATERIALIZED VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    COALESCE(pp.priority, 100) AS prio
  FROM fitness.activity a
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = a.provider_id
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.activity_type = r2.activity_type
    AND r1.user_id = r2.user_id
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

-- v_sleep: canonical sleep sessions with user_id
CREATE MATERIALIZED VIEW fitness.v_sleep AS
WITH RECURSIVE ranked AS (
  SELECT
    s.*,
    COALESCE(pp.priority, 100) AS prio
  FROM fitness.sleep_session s
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = s.provider_id
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.id < r2.id
    AND r1.user_id = r2.user_id
    AND r1.is_nap = r2.is_nap
    AND EXTRACT(EPOCH FROM (
      LEAST(COALESCE(r1.ended_at, r1.started_at + interval '8 hours'),
            COALESCE(r2.ended_at, r2.started_at + interval '8 hours'))
      - GREATEST(r1.started_at, r2.started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(COALESCE(r1.ended_at, r1.started_at + interval '8 hours'),
               COALESCE(r2.ended_at, r2.started_at + interval '8 hours'))
      - LEAST(r1.started_at, r2.started_at)
    )), 0) > 0.8
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(sleep_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.sleep_id = e.a
),
final_groups AS (
  SELECT sleep_id, MIN(group_id) AS group_id FROM clusters GROUP BY sleep_id
),
best AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.*
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.sleep_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
)
SELECT
  b.id,
  b.provider_id,
  b.user_id,
  b.started_at,
  b.ended_at,
  b.duration_minutes,
  b.deep_minutes,
  b.rem_minutes,
  b.light_minutes,
  b.awake_minutes,
  b.efficiency_pct,
  b.is_nap,
  (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
   FROM final_groups fg JOIN ranked r ON r.id = fg.sleep_id
   WHERE fg.group_id = b.group_id) AS source_providers
FROM best b
ORDER BY b.started_at DESC;

CREATE UNIQUE INDEX v_sleep_id_idx ON fitness.v_sleep (id);
CREATE INDEX v_sleep_time_idx ON fitness.v_sleep (started_at DESC);

--> statement-breakpoint

-- v_body_measurement: canonical body measurements with user_id
CREATE MATERIALIZED VIEW fitness.v_body_measurement AS
WITH RECURSIVE ranked AS (
  SELECT
    b.*,
    COALESCE(pp.priority, 100) AS prio
  FROM fitness.body_measurement b
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = b.provider_id
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.id < r2.id
    AND r1.user_id = r2.user_id
    AND ABS(EXTRACT(EPOCH FROM (r1.recorded_at - r2.recorded_at))) < 300
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(measurement_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.measurement_id = e.a
),
final_groups AS (
  SELECT measurement_id, MIN(group_id) AS group_id FROM clusters GROUP BY measurement_id
),
best AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.recorded_at,
    r.prio
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.measurement_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
)
SELECT
  b.canonical_id AS id,
  b.provider_id,
  b.user_id,
  b.recorded_at,
  (SELECT r.weight_kg FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.weight_kg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS weight_kg,
  (SELECT r.body_fat_pct FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.body_fat_pct IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS body_fat_pct,
  (SELECT r.muscle_mass_kg FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.muscle_mass_kg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS muscle_mass_kg,
  (SELECT r.bmi FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.bmi IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS bmi,
  (SELECT r.systolic_bp FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.systolic_bp IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS systolic_bp,
  (SELECT r.diastolic_bp FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.diastolic_bp IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS diastolic_bp,
  (SELECT r.temperature_c FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.temperature_c IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS temperature_c,
  (SELECT r.height_cm FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id AND r.height_cm IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS height_cm,
  (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id) FROM final_groups fg JOIN ranked r ON r.id = fg.measurement_id WHERE fg.group_id = b.group_id) AS source_providers
FROM best b
ORDER BY b.recorded_at DESC;

CREATE UNIQUE INDEX v_body_measurement_id_idx ON fitness.v_body_measurement (id);
CREATE INDEX v_body_measurement_time_idx ON fitness.v_body_measurement (recorded_at DESC);

--> statement-breakpoint

-- v_daily_metrics: one merged row per (user_id, date)
CREATE MATERIALIZED VIEW fitness.v_daily_metrics AS
WITH ranked AS (
  SELECT
    d.*,
    COALESCE(pp.priority, 100) AS prio
  FROM fitness.daily_metrics d
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = d.provider_id
)
SELECT
  dm.date,
  dm.user_id,
  (SELECT r.resting_hr FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.resting_hr IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS resting_hr,
  (SELECT r.hrv FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.hrv IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS hrv,
  (SELECT r.vo2max FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.vo2max IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS vo2max,
  (SELECT r.spo2_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.spo2_avg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS spo2_avg,
  (SELECT r.respiratory_rate_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.respiratory_rate_avg IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS respiratory_rate_avg,
  (SELECT r.skin_temp_c FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.skin_temp_c IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS skin_temp_c,
  (SELECT r.steps FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.steps IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS steps,
  (SELECT r.active_energy_kcal FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.active_energy_kcal IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS active_energy_kcal,
  (SELECT r.basal_energy_kcal FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.basal_energy_kcal IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS basal_energy_kcal,
  (SELECT r.distance_km FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.distance_km IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS distance_km,
  (SELECT r.flights_climbed FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.flights_climbed IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS flights_climbed,
  (SELECT r.exercise_minutes FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.exercise_minutes IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS exercise_minutes,
  (SELECT r.stand_hours FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.stand_hours IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS stand_hours,
  (SELECT r.walking_speed FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_speed IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS walking_speed,
  (SELECT r.environmental_audio_exposure FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.environmental_audio_exposure IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS environmental_audio_exposure,
  (SELECT r.headphone_audio_exposure FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.headphone_audio_exposure IS NOT NULL ORDER BY r.prio ASC LIMIT 1) AS headphone_audio_exposure,
  array_agg(DISTINCT dm.provider_id ORDER BY dm.provider_id) AS source_providers
FROM fitness.daily_metrics dm
GROUP BY dm.date, dm.user_id;

CREATE UNIQUE INDEX v_daily_metrics_date_idx ON fitness.v_daily_metrics (date, user_id);
