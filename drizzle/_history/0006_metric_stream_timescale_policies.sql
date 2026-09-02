-- Configure Timescale settings for fitness.metric_stream once it is a hypertable.
-- Safe to run repeatedly: if metric_stream is not yet a hypertable, this migration
-- is a no-op and emits a NOTICE.

DO $$
DECLARE
  is_hypertable boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'fitness'
      AND hypertable_name = 'metric_stream'
  )
  INTO is_hypertable;

  IF NOT is_hypertable THEN
    RAISE NOTICE 'Skipping Timescale policy setup: fitness.metric_stream is not a hypertable yet.';
    RETURN;
  END IF;

  -- Keep chunk size bounded for policy execution and query pruning.
  PERFORM set_chunk_time_interval('fitness.metric_stream', INTERVAL '1 day');

  -- Enable compression with query-friendly segment/order keys.
  EXECUTE $sql$
    ALTER TABLE fitness.metric_stream
    SET (
      timescaledb.compress = true,
      timescaledb.compress_segmentby = 'user_id,provider_id,channel',
      timescaledb.compress_orderby = 'recorded_at DESC'
    )
  $sql$;

  -- Compress chunks older than 7 days.
  PERFORM add_compression_policy(
    'fitness.metric_stream',
    compress_after => INTERVAL '7 days',
    if_not_exists => true
  );
END
$$;
