-- Run these OUTSIDE a transaction (e.g. via psql directly).
-- CONCURRENTLY avoids table locks but cannot run inside a transaction block.
-- These are NOT part of the automated migration because they can OOM on large tables.

CREATE INDEX CONCURRENTLY IF NOT EXISTS metric_stream_power_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE power > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS metric_stream_hr_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS v_metric_stream_power_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE power > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS v_metric_stream_hr_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;
