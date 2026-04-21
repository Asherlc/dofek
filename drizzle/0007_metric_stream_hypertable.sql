-- Ensure metric_stream is always a Timescale hypertable.
-- Automatic for fresh/empty environments; non-empty legacy tables must be
-- converted in a controlled maintenance window.

DO $$
DECLARE
  is_hypertable boolean;
  has_rows boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'fitness'
      AND hypertable_name = 'metric_stream'
  )
  INTO is_hypertable;

  IF is_hypertable THEN
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM fitness.metric_stream LIMIT 1)
  INTO has_rows;

  IF has_rows THEN
    RAISE NOTICE
      'Skipping hypertable conversion for non-empty fitness.metric_stream. Run the metric-stream Timescale runbook in a maintenance window.';
    RETURN;
  END IF;

  PERFORM create_hypertable(
    'fitness.metric_stream',
    by_range('recorded_at', INTERVAL '1 day'),
    migrate_data => FALSE,
    if_not_exists => TRUE
  );
END
$$;
