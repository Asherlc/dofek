-- Covering index on metric_stream for index-only scans on activity joins.
-- Eliminates heap fetches for queries that aggregate heart_rate, power, distance, altitude, cadence.
-- Reduces typical activity+metric_stream JOIN from ~7s to ~1s.
CREATE INDEX IF NOT EXISTS metric_stream_activity_covering_idx
ON fitness.metric_stream (activity_id)
INCLUDE (heart_rate, power, distance, altitude, cadence, recorded_at);

--> statement-breakpoint

-- Time-range index on activity for the ubiquitous "WHERE started_at > NOW() - N days" pattern.
CREATE INDEX IF NOT EXISTS activity_started_at_idx
ON fitness.activity (started_at DESC);

--> statement-breakpoint

-- Time-range index on sleep_session for sleep queries.
CREATE INDEX IF NOT EXISTS sleep_session_started_at_idx
ON fitness.sleep_session (started_at DESC);
