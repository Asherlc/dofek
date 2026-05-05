-- ClickHouse FDW connects to the `clickhouse` schema in Postgres and surfaces
-- those tables/views as `postgres_fitness_live.*`. As we migrate query paths
-- from fitness.deduped_sensor / fitness.activity_summary to ClickHouse, more
-- consumers need access to the surrounding PG state (user_profile, v_sleep,
-- daily metrics, derived RHR). Make sure proxy views exist for each.

CREATE SCHEMA IF NOT EXISTS clickhouse;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.user_profile AS
SELECT id, max_hr, resting_hr, ftp, birth_date
FROM fitness.user_profile;

--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.derived_resting_heart_rate AS
WITH sleep_windows AS (
  SELECT
    user_id,
    (ended_at AT TIME ZONE 'UTC')::date AS date,
    started_at,
    ended_at
  FROM fitness.v_sleep
  WHERE is_nap = false
    AND ended_at IS NOT NULL
),
raw_samples AS (
  SELECT
    sw.user_id,
    sw.date,
    ms.provider_id,
    ms.scalar AS heart_rate
  FROM sleep_windows sw
  JOIN fitness.metric_stream ms
    ON ms.user_id = sw.user_id
   AND ms.channel = 'heart_rate'
   AND ms.recorded_at >= sw.started_at
   AND ms.recorded_at <= sw.ended_at
   AND ms.scalar IS NOT NULL
),
best_provider AS (
  SELECT DISTINCT ON (user_id, date)
    user_id,
    date,
    provider_id
  FROM (
    SELECT
      user_id,
      date,
      provider_id,
      count(*) AS sample_count
    FROM raw_samples
    GROUP BY user_id, date, provider_id
  ) provider_counts
  ORDER BY user_id, date, sample_count DESC, provider_id ASC
),
samples AS (
  SELECT
    raw_samples.user_id,
    raw_samples.date,
    raw_samples.heart_rate,
    row_number() OVER (
      PARTITION BY raw_samples.user_id, raw_samples.date
      ORDER BY raw_samples.heart_rate ASC
    ) AS ascending_rank,
    count(*) OVER (PARTITION BY raw_samples.user_id, raw_samples.date) AS sample_count
  FROM raw_samples
  JOIN best_provider
    ON best_provider.user_id = raw_samples.user_id
   AND best_provider.date = raw_samples.date
   AND best_provider.provider_id = raw_samples.provider_id
)
SELECT
  user_id,
  date,
  round(avg(heart_rate))::int AS resting_hr
FROM samples
WHERE sample_count >= 30
  AND ascending_rank <= greatest(ceil(sample_count * 0.10)::int, 1)
GROUP BY user_id, date;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.derived_resting_heart_rate AS
SELECT user_id, date, resting_hr
FROM fitness.derived_resting_heart_rate;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_body_measurement AS
SELECT id, user_id, recorded_at, weight_kg, body_fat_pct, source_providers
FROM fitness.v_body_measurement;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_sleep AS
SELECT id, user_id, started_at, ended_at, duration_minutes, deep_minutes,
       rem_minutes, light_minutes, awake_minutes, efficiency_pct, is_nap,
       sleep_type, source_providers
FROM fitness.v_sleep;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_daily_metrics AS
SELECT user_id, date, hrv, spo2_avg, respiratory_rate_avg, skin_temp_c,
       steps, active_energy_kcal, basal_energy_kcal, distance_km,
       flights_climbed, exercise_minutes, stand_hours, walking_speed,
       walking_step_length, walking_double_support_pct, walking_asymmetry_pct,
       walking_steadiness, source_providers
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
