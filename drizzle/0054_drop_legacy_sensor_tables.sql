-- ============================================================
-- Migration 0054: Remove legacy sensor tables after cutover
-- ============================================================
-- Prerequisite: all runtime code paths must read/write fitness.sensor_sample.
-- This migration permanently removes the old wide-row storage tables.

-- Backfill procedures are no longer needed once legacy tables are dropped.
DROP PROCEDURE IF EXISTS drizzle.backfill_metric_stream_to_sensor_sample(interval);
DROP PROCEDURE IF EXISTS drizzle.backfill_imu_to_sensor_sample(interval);
DROP PROCEDURE IF EXISTS drizzle.backfill_orientation_to_sensor_sample(interval);

--> statement-breakpoint

DROP TABLE IF EXISTS drizzle.sensor_sample_backfill_progress;

--> statement-breakpoint

DROP TABLE IF EXISTS fitness.metric_stream CASCADE;
DROP TABLE IF EXISTS fitness.inertial_measurement_unit_sample CASCADE;
DROP TABLE IF EXISTS fitness.orientation_sample CASCADE;
