-- Drop the old wide-row metric_stream table (replaced by the per-channel
-- sensor_sample table, which we rename to metric_stream below).
-- CASCADE drops any views that depend on it.
-- squawk:ignore-next-statement
DROP TABLE IF EXISTS fitness.metric_stream CASCADE;

-- Rename sensor_sample → metric_stream
ALTER TABLE fitness.sensor_sample RENAME TO metric_stream;

-- Rename indexes to match the new table name
ALTER INDEX IF EXISTS fitness.sensor_sample_activity_channel_time_idx
  RENAME TO metric_stream_activity_channel_time_idx;
ALTER INDEX IF EXISTS fitness.sensor_sample_user_channel_time_idx
  RENAME TO metric_stream_user_channel_time_idx;
ALTER INDEX IF EXISTS fitness.sensor_sample_provider_time_idx
  RENAME TO metric_stream_provider_time_idx;

-- Clear stored view hashes so syncMaterializedViews() recreates all views
-- that referenced the old table names.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__view_hashes') THEN
    DELETE FROM drizzle.__view_hashes;
  END IF;
END $$;
