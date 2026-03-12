CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.max_metrics AS
SELECT
  MAX(heart_rate) AS max_heart_rate,
  MAX(power) AS max_power
FROM fitness.v_metric_stream
WHERE activity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS max_metrics_const_idx ON fitness.max_metrics ((1));
