-- Limit memory usage during index creation to avoid OOM on large tables
SET maintenance_work_mem = '64MB';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS metric_stream_power_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE power > 0;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS metric_stream_hr_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS v_metric_stream_power_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE power > 0;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS v_metric_stream_hr_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;

--> statement-breakpoint

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.max_metrics AS
SELECT
  MAX(heart_rate) AS max_heart_rate,
  MAX(power) AS max_power
FROM fitness.v_metric_stream
WHERE activity_id IS NOT NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS max_metrics_const_idx ON fitness.max_metrics ((1));
