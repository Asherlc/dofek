-- R-R intervals max ~2000ms, smallint (max 32767) is correct and space-efficient
-- for a high-volume hypertable with 1 Hz data.
-- squawk-ignore prefer-bigint-over-smallint
ALTER TABLE fitness.metric_stream ADD COLUMN rr_interval_ms smallint;
