-- Add indexes for common query patterns that are missing from materialized views
-- and base tables. Most tRPC queries filter by user_id + time range, but several
-- views/tables lack the right composite indexes, causing sequential scans.

-- v_daily_metrics: queries do WHERE user_id = X AND date > Y
-- Existing index is (date, user_id) — wrong order for equality on user_id first
CREATE INDEX IF NOT EXISTS v_daily_metrics_user_date_idx
ON fitness.v_daily_metrics (user_id, date DESC);

--> statement-breakpoint

-- v_sleep: queries do WHERE user_id = X AND is_nap = false AND started_at > Y
-- Only has (started_at DESC) — no user_id index at all
CREATE INDEX IF NOT EXISTS v_sleep_user_nap_time_idx
ON fitness.v_sleep (user_id, is_nap, started_at DESC);

--> statement-breakpoint

-- v_body_measurement: queries do WHERE user_id = X AND recorded_at > Y
-- Only has (recorded_at DESC) — no user_id index
CREATE INDEX IF NOT EXISTS v_body_measurement_user_time_idx
ON fitness.v_body_measurement (user_id, recorded_at DESC);

--> statement-breakpoint

-- nutrition_daily: queries do WHERE user_id = X AND date > Y
-- Only has (user_id, provider_id) — no (user_id, date) index
CREATE INDEX IF NOT EXISTS nutrition_daily_user_date_idx
ON fitness.nutrition_daily (user_id, date DESC);

--> statement-breakpoint

-- body_measurement: healthspan queries do WHERE user_id = X AND weight_kg IS NOT NULL ORDER BY recorded_at DESC LIMIT 1
-- Only has (user_id, provider_id) — no (user_id, recorded_at) index
CREATE INDEX IF NOT EXISTS body_measurement_user_time_idx
ON fitness.body_measurement (user_id, recorded_at DESC);

--> statement-breakpoint

-- strength_workout: queries do WHERE user_id = X AND started_at > Y
-- Only has (provider_id, external_id) — no user+time index
CREATE INDEX IF NOT EXISTS strength_workout_user_time_idx
ON fitness.strength_workout (user_id, started_at DESC);

--> statement-breakpoint

-- metric_stream: healthspan HR zone query scans with WHERE user_id = X AND heart_rate IS NOT NULL AND recorded_at > Y
-- Partial index avoids scanning rows with null heart_rate (many metric_stream rows have no HR)
CREATE INDEX IF NOT EXISTS metric_stream_user_hr_time_idx
ON fitness.metric_stream (user_id, recorded_at DESC)
WHERE heart_rate IS NOT NULL;

--> statement-breakpoint

-- activity_summary: queries do WHERE user_id = X AND started_at::date >= Y
-- The existing activity_summary_user_time index on (user_id, started_at DESC)
-- already covers these queries via range scan — no expression index needed.
