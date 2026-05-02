SELECT public.set_chunk_time_interval('fitness.metric_stream', INTERVAL '1 day');
--> statement-breakpoint
SET lock_timeout = '10s';
--> statement-breakpoint
DROP INDEX IF EXISTS fitness.metric_stream_provider_time_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS fitness.metric_stream_recorded_at_idx;
