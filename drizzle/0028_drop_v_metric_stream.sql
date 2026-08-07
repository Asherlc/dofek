-- Drop the dead `fitness.v_metric_stream` materialized view (and its indexes,
-- which are dropped automatically with it). Sensor deduplication moved to
-- ClickHouse (analytics.deduped_sensor); no code reader or refresh path
-- references this view. Part of the Postgres metric-stream retirement
-- (docs/metric-stream-postgres-retirement.md P1.4).
DROP MATERIALIZED VIEW IF EXISTS fitness.v_metric_stream;
