-- TEMPORARY MIGRATION: Remove from git after successful deploy + re-sync.
-- Truncates all data tables so we can rebuild schema with hypertable + multi-user.

-- Truncate all data tables (CASCADE handles FK references)
TRUNCATE fitness.metric_stream,
         fitness.activity,
         fitness.sleep_session,
         fitness.daily_metrics,
         fitness.body_measurement,
         fitness.food_entry,
         fitness.nutrition_daily,
         fitness.strength_workout, fitness.strength_set,
         fitness.lab_result,
         fitness.health_event,
         fitness.journal_entry,
         fitness.life_events,
         fitness.sync_log
CASCADE;

--> statement-breakpoint

-- Drop existing materialized views (will be recreated in 0020)
DROP MATERIALIZED VIEW IF EXISTS fitness.v_metric_stream;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_activity;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement;
DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics;

--> statement-breakpoint

-- Drop metric_stream table (must recreate as hypertable in 0020)
DROP TABLE IF EXISTS fitness.metric_stream;
