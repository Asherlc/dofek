-- ============================================================
-- Migration 0039: Per-source daily metrics
-- ============================================================
-- The daily_metrics table previously stored one aggregated row per
-- (date, provider_id). For providers like Apple Health that aggregate
-- data from multiple devices (iPhone, Apple Watch, Wahoo TICKR, etc.),
-- additive metrics (steps, active energy, distance) were naively summed
-- across all sources at insert time — roughly doubling values for users
-- with both iPhone and Apple Watch.
--
-- This migration adds source_name to the uniqueness constraint so each
-- device gets its own row. The v_daily_metrics materialized view already
-- has device-level priority logic (from migration 0032) that picks the
-- best source per metric — it just needs multiple source rows to choose
-- from.
--
-- source_name stays nullable: NULL means "single source / not applicable"
-- (most providers). NULLS NOT DISTINCT ensures that two rows with
-- (date, provider_id, NULL) are treated as duplicates.
-- ============================================================

-- 1. Drop dependent materialized view
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

--> statement-breakpoint

-- 2. Add UUID primary key column, replace composite PK with a
--    NULLS NOT DISTINCT unique index that includes source_name.
--    This allows multiple rows per (date, provider_id) when source_name
--    differs (Apple Health), while treating NULL source_name values as
--    equal (all other providers).
ALTER TABLE fitness.daily_metrics ADD COLUMN id uuid DEFAULT gen_random_uuid();
UPDATE fitness.daily_metrics SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE fitness.daily_metrics ALTER COLUMN id SET NOT NULL;
ALTER TABLE fitness.daily_metrics DROP CONSTRAINT daily_metrics_date_provider_id_pk;
ALTER TABLE fitness.daily_metrics ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX daily_metrics_date_provider_source_idx
  ON fitness.daily_metrics (date, provider_id, source_name) NULLS NOT DISTINCT;

--> statement-breakpoint

-- 3. Add iPhone device priority for apple_health (lower priority than Watch
--    for daily activity, so the view prefers Apple Watch step counts)
INSERT INTO fitness.device_priority (provider_id, source_name_pattern, daily_activity_priority)
VALUES ('apple_health', '%iPhone%', 50)
ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET daily_activity_priority = 50;

--> statement-breakpoint

-- 4. Recreate v_daily_metrics (same as migration 0032, device-aware priorities)
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
