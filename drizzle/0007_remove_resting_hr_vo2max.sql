DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

--> statement-breakpoint

ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS resting_hr;

--> statement-breakpoint

ALTER TABLE fitness.daily_metrics DROP COLUMN IF EXISTS vo2max;
