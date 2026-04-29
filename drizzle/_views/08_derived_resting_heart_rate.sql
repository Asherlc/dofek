-- Canonical definition of the fitness.derived_resting_heart_rate materialized view.
-- Derived from raw sleep-window heart-rate samples.

CREATE MATERIALIZED VIEW fitness.derived_resting_heart_rate AS
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

CREATE UNIQUE INDEX IF NOT EXISTS derived_resting_heart_rate_user_date_idx
  ON fitness.derived_resting_heart_rate (user_id, date);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS derived_resting_heart_rate_date_idx
  ON fitness.derived_resting_heart_rate (date DESC);
