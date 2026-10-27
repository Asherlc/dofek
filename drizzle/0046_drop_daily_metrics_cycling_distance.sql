DROP VIEW IF EXISTS clickhouse.v_daily_metrics;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fitness'
      AND c.relname = 'v_daily_metrics'
      AND c.relkind = 'v'
  ) THEN
    DROP VIEW fitness.v_daily_metrics;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fitness'
      AND c.relname = 'v_daily_metrics'
      AND c.relkind = 'm'
  ) THEN
    DROP MATERIALIZED VIEW fitness.v_daily_metrics;
  END IF;
END
$$;

ALTER TABLE fitness.daily_metrics
DROP CONSTRAINT IF EXISTS daily_metrics_cycling_distance_nonneg_chk;

ALTER TABLE fitness.daily_metrics
DROP COLUMN IF EXISTS cycling_distance_km;

CREATE VIEW fitness.v_daily_metrics AS
WITH ranked AS (
  SELECT
    d.*,
    COALESCE(dp.recovery_priority, pp.recovery_priority, dp.priority, pp.priority, 100) AS recovery_prio,
    COALESCE(dp.daily_activity_priority, pp.daily_activity_priority, dp.priority, pp.priority, 100) AS activity_prio
  FROM fitness.daily_metrics AS d
  LEFT JOIN fitness.provider_priority AS pp ON d.provider_id = pp.provider_id
  LEFT JOIN LATERAL (
    SELECT
      dp2.recovery_priority,
      dp2.daily_activity_priority,
      dp2.priority
    FROM fitness.device_priority AS dp2
    WHERE
      dp2.provider_id = d.provider_id
      AND d.source_name LIKE dp2.source_name_pattern
    ORDER BY LENGTH(dp2.source_name_pattern) DESC
    LIMIT 1
  ) AS dp ON true
)

SELECT
  dm.date,
  dm.user_id,
  (
    SELECT r.hrv FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.hrv IS NOT null
    ORDER BY r.recovery_prio ASC LIMIT 1
  ) AS hrv,
  (
    SELECT r.spo2_avg FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.spo2_avg IS NOT null
    ORDER BY r.recovery_prio ASC LIMIT 1
  ) AS spo2_avg,
  (
    SELECT r.respiratory_rate_avg FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.respiratory_rate_avg IS NOT null
    ORDER BY r.recovery_prio ASC LIMIT 1
  ) AS respiratory_rate_avg,
  (
    SELECT r.skin_temp_c FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.skin_temp_c IS NOT null
    ORDER BY r.recovery_prio ASC LIMIT 1
  ) AS skin_temp_c,
  (
    SELECT r.steps FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.steps IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS steps,
  (
    SELECT r.active_energy_kcal FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.active_energy_kcal IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS active_energy_kcal,
  (
    SELECT r.basal_energy_kcal FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.basal_energy_kcal IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS basal_energy_kcal,
  (
    SELECT r.distance_km FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.distance_km IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS distance_km,
  (
    SELECT r.flights_climbed FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.flights_climbed IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS flights_climbed,
  (
    SELECT r.exercise_minutes FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.exercise_minutes IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS exercise_minutes,
  (
    SELECT r.stand_hours FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.stand_hours IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS stand_hours,
  (
    SELECT r.walking_speed FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_speed IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS walking_speed,
  (
    SELECT r.walking_step_length FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_step_length IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS walking_step_length,
  (
    SELECT r.walking_double_support_pct FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_double_support_pct IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS walking_double_support_pct,
  (
    SELECT r.walking_asymmetry_pct FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_asymmetry_pct IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS walking_asymmetry_pct,
  (
    SELECT r.walking_steadiness FROM ranked AS r
    WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_steadiness IS NOT null
    ORDER BY r.activity_prio ASC LIMIT 1
  ) AS walking_steadiness,
  ARRAY_AGG(DISTINCT dm.provider_id ORDER BY dm.provider_id) AS source_providers
FROM fitness.daily_metrics AS dm
GROUP BY dm.date, dm.user_id;

CREATE VIEW clickhouse.v_daily_metrics AS
SELECT
  user_id,
  date,
  hrv,
  spo2_avg,
  respiratory_rate_avg,
  skin_temp_c,
  steps,
  active_energy_kcal,
  basal_energy_kcal,
  distance_km,
  flights_climbed,
  exercise_minutes,
  stand_hours,
  walking_speed,
  walking_step_length,
  walking_double_support_pct,
  walking_asymmetry_pct,
  walking_steadiness
FROM fitness.v_daily_metrics;
