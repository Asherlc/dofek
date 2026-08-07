CREATE SCHEMA IF NOT EXISTS clickhouse;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fitness.location_sample (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  provider_id text NOT NULL REFERENCES fitness.provider (id),
  activity_id uuid REFERENCES fitness.activity (id) ON DELETE CASCADE,
  device_id text,
  source_type text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  horizontal_accuracy_m real,
  gps_accuracy_m real,
  raw jsonb, -- noqa: RF04
  CONSTRAINT location_sample_pkey PRIMARY KEY (id, recorded_at)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS location_sample_activity_time_idx
ON fitness.location_sample (activity_id, recorded_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS location_sample_user_time_idx
ON fitness.location_sample (user_id, recorded_at);

--> statement-breakpoint

SELECT public.create_hypertable(
  'fitness.location_sample'::regclass,
  'recorded_at'::name,
  if_not_exists => TRUE
);

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.user_profile AS
SELECT
  id,
  max_hr,
  resting_hr,
  ftp,
  birth_date
FROM fitness.user_profile;

--> statement-breakpoint

DROP VIEW IF EXISTS clickhouse.v_body_measurement;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_sleep AS
SELECT
  id,
  user_id,
  started_at,
  ended_at,
  duration_minutes,
  deep_minutes,
  rem_minutes,
  light_minutes,
  awake_minutes,
  efficiency_pct,
  is_nap,
  sleep_type
FROM fitness.v_sleep;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_daily_metrics AS
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

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.activity AS
SELECT
  id,
  user_id,
  provider_id,
  activity_type,
  name,
  started_at,
  ended_at,
  source_name
FROM fitness.activity;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.daily_metrics AS
SELECT
  id,
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
  provider_id,
  source_name
FROM fitness.daily_metrics;
