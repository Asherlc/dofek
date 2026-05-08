CREATE SCHEMA IF NOT EXISTS clickhouse;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.user_profile AS
SELECT id, max_hr, resting_hr, ftp, birth_date
FROM fitness.user_profile;

--> statement-breakpoint

DROP VIEW IF EXISTS clickhouse.v_body_measurement;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_sleep AS
SELECT id, user_id, started_at, ended_at, duration_minutes, deep_minutes,
       rem_minutes, light_minutes, awake_minutes, efficiency_pct, is_nap,
       sleep_type
FROM fitness.v_sleep;

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
