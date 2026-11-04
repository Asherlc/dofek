CREATE TABLE fitness.analytics_run (
  id UUID PRIMARY KEY,
  owner_id UUID,
  sealed BOOLEAN NOT NULL DEFAULT FALSE
);
--> statement-breakpoint
CREATE TABLE fitness.analytics_required_frontier (
  run_id UUID NOT NULL REFERENCES fitness.analytics_run (id) ON DELETE CASCADE,
  operation_id UUID NOT NULL REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  user_id UUID REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  dataset_key TEXT NOT NULL,
  epoch TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  position JSONB NOT NULL,
  PRIMARY KEY (run_id, operation_id, dataset_key, epoch, topic, partition)
);
--> statement-breakpoint
CREATE TABLE fitness.analytics_stream_state (
  epoch TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  owner_id UUID NOT NULL,
  processed JSONB,
  pending JSONB,
  PRIMARY KEY (epoch, topic, partition)
);
--> statement-breakpoint
CREATE TABLE fitness.analytics_stage_cursor (
  run_id UUID NOT NULL REFERENCES fitness.analytics_run (id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  epoch TEXT NOT NULL,
  topic TEXT NOT NULL,
  partition INTEGER NOT NULL,
  cursor JSONB NOT NULL,
  PRIMARY KEY (run_id, stage, epoch, topic, partition),
  CONSTRAINT analytics_stage_cursor_stage CHECK (stage IN ('scalar', 'dedup', 'activity'))
);
