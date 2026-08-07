-- ClickHouse FDW connects to the `clickhouse` schema in Postgres and surfaces
-- those tables/views as `postgres_fitness_live.*`. As we migrate query paths
-- from fitness.deduped_sensor / fitness.activity_summary to ClickHouse, more
-- consumers need access to the surrounding PG state (user_profile, v_sleep,
-- daily metrics). Make sure proxy views exist for each.

CREATE SCHEMA IF NOT EXISTS clickhouse;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.user_profile AS
SELECT id, max_hr, resting_hr, ftp, birth_date
FROM fitness.user_profile;

--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_body_measurement AS
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

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_body_measurement AS
SELECT id, user_id, recorded_at, weight_kg, body_fat_pct
FROM fitness.v_body_measurement;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_sleep AS
SELECT id, user_id, started_at, ended_at, duration_minutes, deep_minutes,
       rem_minutes, light_minutes, awake_minutes, efficiency_pct, is_nap,
       sleep_type
FROM fitness.v_sleep;

--> statement-breakpoint

DROP VIEW IF EXISTS clickhouse.v_daily_metrics;

--> statement-breakpoint

DO $$
DECLARE
  relation_kind "char";
BEGIN
  SELECT c.relkind
  INTO relation_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'fitness'
    AND c.relname = 'v_daily_metrics';

  IF relation_kind = 'v' THEN
    DROP VIEW fitness.v_daily_metrics;
  ELSIF relation_kind = 'm' THEN
    DROP MATERIALIZED VIEW fitness.v_daily_metrics;
  END IF;
END
$$;

--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_daily_metrics AS
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
  (SELECT r.hrv FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.hrv IS NOT NULL ORDER BY r.recovery_prio ASC LIMIT 1) AS hrv,
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
  (SELECT r.walking_step_length FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_step_length IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS walking_step_length,
  (SELECT r.walking_double_support_pct FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_double_support_pct IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS walking_double_support_pct,
  (SELECT r.walking_asymmetry_pct FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_asymmetry_pct IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS walking_asymmetry_pct,
  (SELECT r.walking_steadiness FROM ranked r WHERE r.date = dm.date AND r.user_id = dm.user_id AND r.walking_steadiness IS NOT NULL ORDER BY r.activity_prio ASC LIMIT 1) AS walking_steadiness,
  array_agg(DISTINCT dm.provider_id ORDER BY dm.provider_id) AS source_providers
FROM fitness.daily_metrics dm
GROUP BY dm.date, dm.user_id;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_daily_metrics AS
SELECT user_id, date, hrv, spo2_avg, respiratory_rate_avg, skin_temp_c,
       steps, active_energy_kcal, basal_energy_kcal, distance_km,
       flights_climbed, exercise_minutes, stand_hours, walking_speed,
       walking_step_length, walking_double_support_pct, walking_asymmetry_pct,
       walking_steadiness
FROM fitness.v_daily_metrics;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.activity AS
SELECT id, user_id, provider_id, activity_type, name, started_at, ended_at, source_name
FROM fitness.activity;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.daily_metrics AS
SELECT id, user_id, date, hrv, spo2_avg, respiratory_rate_avg, skin_temp_c,
       steps, active_energy_kcal, basal_energy_kcal, distance_km,
       flights_climbed, exercise_minutes, stand_hours, walking_speed,
       provider_id, source_name
FROM fitness.daily_metrics;
