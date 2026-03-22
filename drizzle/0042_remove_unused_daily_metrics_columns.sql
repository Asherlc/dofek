-- ============================================================
-- Migration 0042: Remove unused daily_metrics columns
-- ============================================================
-- Three columns in daily_metrics were never populated by any provider:
--
-- 1. mindful_minutes — added in migration 0008 but never wired to any
--    provider's sync logic.
--
-- 2. environmental_audio_exposure — Apple Health stores raw readings in
--    metric_stream.audio_exposure but no aggregation to daily_metrics
--    was ever implemented. No other provider populates it either.
--
-- 3. headphone_audio_exposure — same as environmental_audio_exposure.
--
-- The raw audio exposure time-series data remains in metric_stream for
-- anyone who wants to query it directly.
-- ============================================================

-- 1. Drop dependent materialized view
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

--> statement-breakpoint

-- 2. Drop unused columns
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS mindful_minutes;
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS environmental_audio_exposure;
ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS headphone_audio_exposure;

--> statement-breakpoint

-- 3. Recreate v_daily_metrics without the removed columns
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
  array_agg(DISTINCT dm.provider_id ORDER BY dm.provider_id) AS source_providers
FROM fitness.daily_metrics dm
GROUP BY dm.date, dm.user_id;

CREATE UNIQUE INDEX v_daily_metrics_date_idx ON fitness.v_daily_metrics (date, user_id);
