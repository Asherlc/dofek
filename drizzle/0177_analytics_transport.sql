ALTER TABLE fitness.analytics_stream_state
ADD COLUMN transport TEXT NOT NULL DEFAULT 'pulsar';
--> statement-breakpoint
ALTER TABLE fitness.analytics_required_frontier
ADD COLUMN transport TEXT NOT NULL DEFAULT 'pulsar';
--> statement-breakpoint
ALTER TABLE fitness.analytics_stage_cursor
ADD COLUMN transport TEXT NOT NULL DEFAULT 'pulsar';
--> statement-breakpoint
ALTER TABLE fitness.analytics_stream_state
DROP CONSTRAINT analytics_stream_state_pkey,
ADD PRIMARY KEY (transport, epoch, topic, partition),
ALTER COLUMN transport DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE fitness.analytics_required_frontier
DROP CONSTRAINT analytics_required_frontier_pkey,
ADD PRIMARY KEY (run_id, operation_id, dataset_key, transport, epoch, topic, partition),
ALTER COLUMN transport DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE fitness.analytics_stage_cursor
DROP CONSTRAINT analytics_stage_cursor_pkey,
ADD PRIMARY KEY (run_id, stage, transport, epoch, topic, partition),
ALTER COLUMN transport DROP DEFAULT;
