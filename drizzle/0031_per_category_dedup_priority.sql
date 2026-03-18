-- ============================================================
-- Migration 0031: Per-category dedup priority
-- ============================================================
-- Different devices have different accuracy for different metrics.
-- Instead of a single global priority, each provider now has
-- category-specific priorities for sleep, body, recovery, and
-- daily activity metrics. Views fall back to the generic priority
-- when a category-specific one is not set.
--
-- Research-based priority rankings (lower = higher priority):
--   Sleep:     Oura (10) > WHOOP (20) > Apple Watch (25) > Fitbit (30)
--   Recovery:  Oura (10) > WHOOP (15) > Apple Watch (25) > Garmin (30)
--   Body:      Withings (10) > Apple Health (80)
--   Daily:     Apple Health (15) > Garmin (20) > Fitbit (30) > WHOOP (80)
--   Activity:  Wahoo (10) > Garmin (15) > Peloton (20) > WHOOP (30)
-- ============================================================

-- 1. Add category-specific priority columns
ALTER TABLE fitness.provider_priority
  ADD COLUMN IF NOT EXISTS sleep_priority INTEGER,
  ADD COLUMN IF NOT EXISTS body_priority INTEGER,
  ADD COLUMN IF NOT EXISTS recovery_priority INTEGER,
  ADD COLUMN IF NOT EXISTS daily_activity_priority INTEGER;

-- Priority data is now loaded from provider-priority.json at runtime
-- (see src/db/provider-priority.ts). The JSON file is the source of truth.

--> statement-breakpoint

-- 3. Recreate v_sleep with sleep-specific priority
DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;

CREATE MATERIALIZED VIEW fitness.v_sleep AS
WITH RECURSIVE ranked AS (
  SELECT
    s.*,
    COALESCE(pp.sleep_priority, pp.priority, 100) AS prio
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

-- 4. Recreate v_body_measurement with body-specific priority
DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement;

CREATE MATERIALIZED VIEW fitness.v_body_measurement AS
WITH RECURSIVE ranked AS (
  SELECT
    b.*,
    COALESCE(pp.body_priority, pp.priority, 100) AS prio
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

-- 5. Recreate v_daily_metrics with per-category priorities
--    Recovery fields (resting_hr, hrv, spo2, respiratory_rate, skin_temp) use recovery_priority.
--    Daily activity fields (steps, calories, distance, flights, etc.) use daily_activity_priority.
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

CREATE MATERIALIZED VIEW fitness.v_daily_metrics AS
WITH ranked AS (
  SELECT
    d.*,
    COALESCE(pp.recovery_priority, pp.priority, 100) AS recovery_prio,
    COALESCE(pp.daily_activity_priority, pp.priority, 100) AS activity_prio
  FROM fitness.daily_metrics d
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = d.provider_id
)
SELECT
  dm.date,
  dm.user_id,
  -- Recovery metrics: use recovery_prio (WHOOP/Oura excel at 24/7 HR/HRV monitoring)
  (SELECT r.resting_hr FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.resting_hr IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS resting_hr,
  (SELECT r.hrv FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.hrv IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS hrv,
  (SELECT r.vo2max FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.vo2max IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS vo2max,
  (SELECT r.spo2_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.spo2_avg IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS spo2_avg,
  (SELECT r.respiratory_rate_avg FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.respiratory_rate_avg IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS respiratory_rate_avg,
  (SELECT r.skin_temp_c FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.skin_temp_c IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS skin_temp_c,
  -- Daily activity metrics: use activity_prio (Apple Watch excels at all-day tracking)
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
