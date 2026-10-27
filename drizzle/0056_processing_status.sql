-- PG01 does not apply to this migration's indexes because every indexed table is
-- created empty immediately before those statements.
-- progress_percentage is constrained to 0..100, metadata_schema_version is a small
-- version number, and expected_event_count is a bounded batch size.
-- squawk-ignore-file prefer-bigint-over-int
CREATE TABLE fitness.processing_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid CONSTRAINT processing_operation_user_fk REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  provider_id text,
  kind text NOT NULL,
  external_correlation_key text,
  dataset_keys text [] NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT processing_operation_kind_valid CHECK (fitness.processing_operation.kind IN ('provider_sync', 'file_import', 'push_ingest', 'data_deletion', 'analytics_build', 'cache_refresh')),
  CONSTRAINT processing_operation_datasets_nonempty CHECK (cardinality(fitness.processing_operation.dataset_keys) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX processing_operation_correlation_key ON fitness.processing_operation USING btree (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, external_correlation_key) WHERE fitness.processing_operation.external_correlation_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX processing_operation_user_created_idx ON fitness.processing_operation USING btree (user_id, created_at DESC NULLS LAST, id); -- noqa: PG01
--> statement-breakpoint
CREATE TABLE fitness.processing_stage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  operation_id uuid NOT NULL CONSTRAINT processing_stage_event_operation_fk REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL,
  dataset_key text,
  output_path text,
  model_name text,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  progress_percentage integer,
  source_watermark text,
  serving_watermark text,
  message text,
  error_code text,
  error_message text,
  metadata_schema_version integer DEFAULT 1 NOT NULL,
  metadata jsonb,
  idempotency_key text NOT NULL,
  CONSTRAINT processing_stage_event_idempotency_key UNIQUE NULLS NOT DISTINCT (operation_id, stage, dataset_key, output_path, model_name, status, idempotency_key),
  CONSTRAINT processing_stage_event_stage_valid CHECK (fitness.processing_stage_event.stage IN ('ingest', 'canonical_commit', 'cdc', 'analytics', 'cache_refresh')),
  CONSTRAINT processing_stage_event_status_valid CHECK (fitness.processing_stage_event.status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  CONSTRAINT processing_stage_event_output_path_valid CHECK (fitness.processing_stage_event.output_path IS NULL OR fitness.processing_stage_event.output_path IN ('relational', 'metric_stream')),
  CONSTRAINT processing_stage_event_progress_valid CHECK (fitness.processing_stage_event.progress_percentage IS NULL OR fitness.processing_stage_event.progress_percentage BETWEEN 0 AND 100),
  CONSTRAINT processing_stage_event_metadata_version_positive CHECK (fitness.processing_stage_event.metadata_schema_version > 0)
);
--> statement-breakpoint
CREATE INDEX processing_stage_event_operation_sequence_idx ON fitness.processing_stage_event USING btree (operation_id, sequence DESC NULLS LAST); -- noqa: PG01
--> statement-breakpoint
CREATE INDEX processing_stage_event_dataset_sequence_idx ON fitness.processing_stage_event USING btree (dataset_key, sequence DESC NULLS LAST); -- noqa: PG01
--> statement-breakpoint
CREATE FUNCTION fitness.reject_processing_stage_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'processing_stage_event is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER processing_stage_event_append_only BEFORE UPDATE OR DELETE ON fitness.processing_stage_event FOR EACH ROW EXECUTE FUNCTION fitness.reject_processing_stage_event_mutation();
--> statement-breakpoint
CREATE TABLE fitness.processing_operation_output (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  operation_id uuid NOT NULL CONSTRAINT processing_operation_output_operation_fk REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  dataset_key text NOT NULL,
  output_path text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT processing_operation_output_key UNIQUE (operation_id, dataset_key, output_path),
  CONSTRAINT processing_operation_output_path_valid CHECK (fitness.processing_operation_output.output_path IN ('relational', 'metric_stream'))
);
--> statement-breakpoint
CREATE TRIGGER processing_operation_output_append_only BEFORE UPDATE OR DELETE ON fitness.processing_operation_output FOR EACH ROW EXECUTE FUNCTION fitness.reject_processing_stage_event_mutation();
--> statement-breakpoint
CREATE TABLE fitness.processing_flow_marker (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  operation_id uuid NOT NULL CONSTRAINT processing_flow_marker_operation_fk REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  dataset_key text NOT NULL,
  flow_name text NOT NULL,
  batch_key text NOT NULL,
  source_watermark text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT processing_flow_marker_operation_dataset_flow UNIQUE (operation_id, dataset_key, flow_name, batch_key)
);
--> statement-breakpoint
CREATE INDEX processing_flow_marker_watermark_idx ON fitness.processing_flow_marker USING btree (source_watermark); -- noqa: PG01
--> statement-breakpoint
CREATE TRIGGER processing_flow_marker_append_only BEFORE UPDATE OR DELETE ON fitness.processing_flow_marker FOR EACH ROW EXECUTE FUNCTION fitness.reject_processing_stage_event_mutation();
--> statement-breakpoint
CREATE TABLE fitness.processing_metric_stream_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  operation_id uuid NOT NULL CONSTRAINT processing_metric_batch_operation_fk REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  dataset_keys text [] NOT NULL,
  expected_event_count integer NOT NULL,
  published_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT processing_metric_stream_batch_key UNIQUE (operation_id, batch_id),
  CONSTRAINT processing_metric_stream_batch_datasets_nonempty CHECK (cardinality(fitness.processing_metric_stream_batch.dataset_keys) > 0),
  CONSTRAINT processing_metric_stream_batch_event_count_positive CHECK (fitness.processing_metric_stream_batch.expected_event_count > 0)
);
--> statement-breakpoint
CREATE TRIGGER processing_metric_stream_batch_append_only BEFORE UPDATE OR DELETE ON fitness.processing_metric_stream_batch FOR EACH ROW EXECUTE FUNCTION fitness.reject_processing_stage_event_mutation();
--> statement-breakpoint
CREATE TABLE fitness.processing_queue_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  operation_id uuid NOT NULL CONSTRAINT processing_queue_outbox_operation_fk REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  queue_name text NOT NULL,
  job_id text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  dispatched_at timestamp with time zone,
  CONSTRAINT processing_queue_outbox_job_key UNIQUE (queue_name, job_id),
  CONSTRAINT processing_queue_outbox_status_valid CHECK (fitness.processing_queue_outbox.status IN ('pending', 'dispatched', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX processing_queue_outbox_dispatch_idx ON fitness.processing_queue_outbox USING btree (status, created_at); -- noqa: PG01
