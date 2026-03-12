-- Partial indexes on metric_stream for common filtered queries.
-- These speed up power curve, NP/FTP, HR zone, TRIMP, and max-HR queries.

-- Power queries (power curve, NP, FTP)
CREATE INDEX IF NOT EXISTS metric_stream_power_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE power > 0;

-- Heart rate queries (HR zones, TRIMP, max HR)
CREATE INDEX IF NOT EXISTS metric_stream_hr_idx
  ON fitness.metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;

-- Same partial indexes on the dedup materialized view
CREATE INDEX IF NOT EXISTS v_metric_stream_power_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE power > 0;

CREATE INDEX IF NOT EXISTS v_metric_stream_hr_idx
  ON fitness.v_metric_stream (activity_id, recorded_at)
  WHERE heart_rate IS NOT NULL;

--> statement-breakpoint

-- Materialized view caching global max metrics.
-- Avoids repeated full-table scans for max HR / max power lookups.
CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.max_metrics AS
SELECT
  MAX(heart_rate) AS max_heart_rate,
  MAX(power) AS max_power
FROM fitness.v_metric_stream
WHERE activity_id IS NOT NULL;

-- Unique index on a constant expression to enable REFRESH CONCURRENTLY
CREATE UNIQUE INDEX ON fitness.max_metrics ((1));
