-- Keep latest-event lookups ordered by their DISTINCT ON keys so scoped
-- processing history does not sort every event row for each operation.
CREATE INDEX processing_stage_event_latest_idx -- noqa: PG01
ON fitness.processing_stage_event USING btree (
  operation_id,
  stage,
  dataset_key,
  output_path,
  model_name,
  sequence DESC NULLS LAST
);
