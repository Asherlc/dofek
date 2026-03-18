-- ============================================================
-- Migration 0032: Add source_name to data tables
-- ============================================================
-- Stores the originating device/app name for each record.
-- Critical for Apple Health (which aggregates from Apple Watch,
-- Wahoo TICKR, Withings, etc.) and Garmin (Edge vs Forerunner).
-- Enables device-level dedup priority.

ALTER TABLE fitness.activity
  ADD COLUMN IF NOT EXISTS source_name TEXT;

--> statement-breakpoint

ALTER TABLE fitness.sleep_session
  ADD COLUMN IF NOT EXISTS source_name TEXT;

--> statement-breakpoint

ALTER TABLE fitness.body_measurement
  ADD COLUMN IF NOT EXISTS source_name TEXT;

--> statement-breakpoint

ALTER TABLE fitness.daily_metrics
  ADD COLUMN IF NOT EXISTS source_name TEXT;

--> statement-breakpoint

ALTER TABLE fitness.metric_stream
  ADD COLUMN IF NOT EXISTS source_name TEXT;

--> statement-breakpoint

-- ============================================================
-- Device priority table: per-device overrides within a provider
-- ============================================================
-- When source_name matches a pattern, use device-specific priority
-- instead of the provider-level default. Loaded from provider-priority.json.

CREATE TABLE IF NOT EXISTS fitness.device_priority (
  provider_id TEXT NOT NULL,
  source_name_pattern TEXT NOT NULL,
  priority INTEGER,
  sleep_priority INTEGER,
  body_priority INTEGER,
  recovery_priority INTEGER,
  daily_activity_priority INTEGER,
  PRIMARY KEY (provider_id, source_name_pattern)
);

--> statement-breakpoint

-- ============================================================
-- Recreate dedup views with device-level priority
-- ============================================================
-- Priority resolution order (first non-null wins):
--   1. device_priority category-specific (e.g., "Apple Watch" sleep_priority)
--   2. provider_priority category-specific (e.g., apple_health sleep_priority)
--   3. device_priority generic (e.g., "Apple Watch" priority)
--   4. provider_priority generic (e.g., apple_health priority)
--   5. Default: 100

-- v_activity: add device priority + expose source_name
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity;

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

-- v_sleep: device-aware sleep priority
DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;

CREATE MATERIALIZED VIEW fitness.v_sleep AS
WITH RECURSIVE ranked AS (
  SELECT
    s.*,
    COALESCE(dp.sleep_priority, pp.sleep_priority, dp.priority, pp.priority, 100) AS prio
  FROM fitness.sleep_session s
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = s.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.sleep_priority, dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = s.provider_id
      AND s.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
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
  b.source_name,
  (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
   FROM final_groups fg JOIN ranked r ON r.id = fg.sleep_id
   WHERE fg.group_id = b.group_id) AS source_providers
FROM best b
ORDER BY b.started_at DESC;

CREATE UNIQUE INDEX v_sleep_id_idx ON fitness.v_sleep (id);
CREATE INDEX v_sleep_time_idx ON fitness.v_sleep (started_at DESC);

--> statement-breakpoint

-- v_body_measurement: device-aware body priority
DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement;

CREATE MATERIALIZED VIEW fitness.v_body_measurement AS
WITH RECURSIVE ranked AS (
  SELECT
    b.*,
    COALESCE(dp.body_priority, pp.body_priority, dp.priority, pp.priority, 100) AS prio
  FROM fitness.body_measurement b
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = b.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.body_priority, dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = b.provider_id
      AND b.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
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

-- v_daily_metrics: device-aware per-category priorities
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

CREATE MATERIALIZED VIEW fitness.v_daily_metrics AS
WITH ranked AS (
  SELECT
    d.*,
    COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) AS recovery_prio,
    COALESCE(dp.daily_activity_priority, pp.daily_activity_priority, dp.priority, pp.priority, 100) AS activity_prio
  FROM fitness.daily_metrics d
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = d.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.recovery_priority, dp2.daily_activity_priority, dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = d.provider_id
      AND d.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
)
SELECT
  dm.date,
  dm.user_id,
  (SELECT r.resting_hr FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.resting_hr IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS resting_hr,
  (SELECT r.hrv FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.hrv IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS hrv,
  (SELECT r.vo2max FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.vo2max IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS vo2max,
  (SELECT r.spo2_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.spo2_avg IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS spo2_avg,
  (SELECT r.respiratory_rate_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.respiratory_rate_avg IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS respiratory_rate_avg,
  (SELECT r.skin_temp_c FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.skin_temp_c IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS skin_temp_c,
  (SELECT r.steps FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.steps IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS steps,
  (SELECT r.active_energy_kcal FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.active_energy_kcal IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS active_energy_kcal,
  (SELECT r.basal_energy_kcal FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.basal_energy_kcal IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS basal_energy_kcal,
  (SELECT r.distance_km FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.distance_km IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS distance_km,
  (SELECT r.flights_climbed FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.flights_climbed IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS flights_climbed,
  (SELECT r.exercise_minutes FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.exercise_minutes IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS exercise_minutes,
  (SELECT r.stand_hours FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.stand_hours IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS stand_hours,
  (SELECT r.walking_speed FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_speed IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS walking_speed,
  (SELECT r.environmental_audio_exposure FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.environmental_audio_exposure IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS environmental_audio_exposure,
  (SELECT r.headphone_audio_exposure FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.headphone_audio_exposure IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS headphone_audio_exposure,
  array_agg(DISTINCT dm.provider_id ORDER BY dm.provider_id) AS source_providers
FROM fitness.daily_metrics dm
GROUP BY dm.date, dm.user_id;

CREATE UNIQUE INDEX v_daily_metrics_date_idx ON fitness.v_daily_metrics (date, user_id);
