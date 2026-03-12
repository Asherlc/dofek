-- Materialized view caching global max metrics.
-- Avoids repeated full-table scans for max HR / max power lookups.
CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.max_metrics AS
SELECT
  MAX(heart_rate) AS max_heart_rate,
  MAX(power) AS max_power
FROM fitness.v_metric_stream
WHERE activity_id IS NOT NULL;

-- Unique index on a constant expression to enable REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS max_metrics_const_idx ON fitness.max_metrics ((1));
