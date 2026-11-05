export const INGEST_DATABASE = "ingest";
export const METRIC_STREAM_TABLE = `${INGEST_DATABASE}.metric_stream`;
export const METRIC_STREAM_DELETE_SCOPE_TABLE = `${INGEST_DATABASE}.metric_stream_delete_scope`;
export const METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE = `${INGEST_DATABASE}.metric_stream_delete_acknowledgement`;
export const METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE = `${INGEST_DATABASE}.metric_stream_processing_acknowledgement`;
export const PROVIDER_DATA_GENERATION_TABLE = `${INGEST_DATABASE}.provider_data_generation`;
export const ACCOUNT_ERASURE_FENCE_TABLE = `${INGEST_DATABASE}.account_erasure_fence`;
export const ACCOUNT_ERASURE_OPERATION_FENCE_TABLE = `${INGEST_DATABASE}.account_erasure_operation_fence`;
export const LEGACY_METRIC_STREAM_TABLE = "postgres_fitness.metric_stream";
export const METRIC_STREAM_ORDER_BY = "(user_id, activity_id, channel, recorded_at, id)";
export const METRIC_STREAM_PROVIDER_GENERATION_PROJECTION = "by_provider_generation";
export const METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION = "by_provider_live_generation";
export const METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION = "by_provider_current_state";
export const METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION =
  "by_provider_current_state_recorded_at";
export const METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION = "by_provider_external_id";
export const METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION = "by_user_channel_recorded_at";
export const METRIC_STREAM_PROVIDER_GENERATION_ORDER_BY = "(user_id, provider_id, generation, id)";
export const METRIC_STREAM_PROVIDER_GENERATION_COVERING_ORDER_BY =
  "(user_id, provider_id, generation, id, version, ingested_at)";
export const METRIC_STREAM_PROVIDER_LIVE_GENERATION_ORDER_BY =
  "(user_id, provider_id, is_deleted, generation, id)";

export const metricStreamIngestMetadataColumnDefinitions = `  ingested_at DateTime64(9) DEFAULT now(),
  is_deleted Int8 DEFAULT 0,
  version Int64 DEFAULT 0,
  generation UInt64 DEFAULT 0`;

export function metricStreamReplacingMergeTreeEngine(): string {
  return `ENGINE = ReplacingMergeTree(version)
ORDER BY ${METRIC_STREAM_ORDER_BY}
SETTINGS allow_nullable_key = 1, deduplicate_merge_projection_mode = 'rebuild'`;
}

export function metricStreamProviderGenerationProjectionDefinition(): string {
  return `SELECT
      id,
      activity_id,
      user_id,
      recorded_at,
      channel,
      provider_id,
      external_id,
      device_id,
      source_type,
      scalar,
      vector,
      point,
      metadata,
      ingested_at,
      is_deleted,
      version,
      generation
    ORDER BY ${METRIC_STREAM_PROVIDER_GENERATION_COVERING_ORDER_BY}`;
}

export function metricStreamProviderLiveGenerationProjectionDefinition(): string {
  return `SELECT user_id, provider_id, is_deleted, generation, id
    ORDER BY ${METRIC_STREAM_PROVIDER_LIVE_GENERATION_ORDER_BY}`;
}

export function metricStreamProviderCurrentStateProjectionDefinition(): string {
  return `SELECT
      user_id,
      provider_id,
      id,
      argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted
    GROUP BY user_id, provider_id, id`;
}

export function metricStreamProviderCurrentStateRecordedAtProjectionDefinition(): string {
  return `SELECT
      user_id,
      provider_id,
      id,
      recorded_at,
      ingested_at,
      version,
      is_deleted
    ORDER BY (user_id, provider_id, recorded_at, id, version, ingested_at)`;
}

export function metricStreamProviderExternalIdProjectionDefinition(): string {
  return `SELECT
      id,
      activity_id,
      user_id,
      recorded_at,
      channel,
      provider_id,
      external_id,
      device_id,
      source_type,
      scalar,
      vector,
      point,
      metadata,
      ingested_at,
      is_deleted,
      version,
      generation
    ORDER BY (user_id, provider_id, external_id, id, version, ingested_at)`;
}

export function metricStreamUserChannelRecordedAtProjectionDefinition(): string {
  return `SELECT user_id, activity_id, channel, recorded_at, id,
      provider_id, scalar, version, ingested_at, is_deleted
    ORDER BY (user_id, channel, recorded_at, activity_id, id)`;
}

export function buildIngestMetricStreamCreateTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_TABLE} (
  id UUID,
  activity_id Nullable(UUID),
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  channel String,
  provider_id String,
  external_id Nullable(String),
  device_id Nullable(String),
  source_type Nullable(String),
  scalar Nullable(Float32),
  vector Array(Float32),
  point String,
  metadata String,
${metricStreamIngestMetadataColumnDefinitions},
  PROJECTION ${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION} (
    ${metricStreamProviderGenerationProjectionDefinition()}
  ),
  PROJECTION ${METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION} (
    ${metricStreamProviderLiveGenerationProjectionDefinition()}
  ),
  PROJECTION ${METRIC_STREAM_PROVIDER_CURRENT_STATE_PROJECTION} (
    ${metricStreamProviderCurrentStateProjectionDefinition()}
  ),
  PROJECTION ${METRIC_STREAM_PROVIDER_CURRENT_STATE_RECORDED_AT_PROJECTION} (
    ${metricStreamProviderCurrentStateRecordedAtProjectionDefinition()}
  ),
  PROJECTION ${METRIC_STREAM_PROVIDER_EXTERNAL_ID_PROJECTION} (
    ${metricStreamProviderExternalIdProjectionDefinition()}
  ),
  PROJECTION ${METRIC_STREAM_USER_CHANNEL_RECORDED_AT_PROJECTION} (
    ${metricStreamUserChannelRecordedAtProjectionDefinition()}
  )
)
${metricStreamReplacingMergeTreeEngine()}`;
}

export function buildMetricStreamSourcePlacementIngestSql(): string {
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.source_placement_ingest
    TO analytics.source_placement AS
    SELECT id AS source_id,user_id,provider_id,toUInt64(version) AS source_version,
      generation,channel,recorded_at,ingested_at,activity_id,toUInt8(is_deleted) AS deleted
    FROM ${METRIC_STREAM_TABLE}`;
}

export function buildMetricStreamDeleteAcknowledgementTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (
  event_id UUID,
  applied_at DateTime64(9) DEFAULT now64(9)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY event_id`;
}

export function buildMetricStreamDeleteScopeTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_DELETE_SCOPE_TABLE} (
  user_id Nullable(UUID),
  provider_id Nullable(String),
  activity_id Nullable(UUID),
  channel Nullable(String),
  external_id Nullable(String),
  external_id_set UInt8,
  recorded_at_start Nullable(DateTime64(6, 'UTC')),
  recorded_at_end Nullable(DateTime64(6, 'UTC')),
  operation_revision UInt64
)
ENGINE = ReplacingMergeTree(operation_revision)
ORDER BY (user_id, provider_id, activity_id, channel, external_id_set, external_id, recorded_at_start, recorded_at_end)
SETTINGS allow_nullable_key = 1`;
}

export function metricStreamProcessingPositionConstraint(): string {
  return `(marker_transport = 'kafka' AND isNotNull(marker_offset)
    AND isNull(marker_epoch) AND isNull(marker_message_id))
    OR (marker_transport = 'pulsar' AND isNull(marker_offset)
      AND notEmpty(ifNull(marker_epoch, '')) AND notEmpty(ifNull(marker_message_id, '')))`;
}

export function buildMetricStreamProcessingAcknowledgementTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE} (
  operation_id UUID,
  batch_id String,
  dataset_keys Array(String),
  expected_event_count UInt64,
  topic String,
  topic_partition Int32,
  marker_offset Nullable(UInt64),
  marker_transport Enum8('kafka' = 1, 'pulsar' = 2) DEFAULT 'kafka',
  marker_epoch Nullable(String),
  marker_message_id Nullable(String),
  applied_at DateTime64(9) DEFAULT now64(9),
  CONSTRAINT valid_marker_position CHECK ${metricStreamProcessingPositionConstraint()}
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY (operation_id, batch_id)`;
}

export function buildProviderDataGenerationTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${PROVIDER_DATA_GENERATION_TABLE} (
  user_id UUID,
  provider_id String,
  generation UInt64,
  updated_at DateTime64(9) DEFAULT now64(9)
)
ENGINE = ReplacingMergeTree(generation)
ORDER BY (user_id, provider_id)`;
}

export function buildAccountErasureFenceTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${ACCOUNT_ERASURE_FENCE_TABLE} (
  user_hash FixedString(64),
  erased_at DateTime64(9) DEFAULT now64(9)
)
ENGINE = ReplacingMergeTree(erased_at)
ORDER BY user_hash`;
}

export function buildAccountErasureOperationFenceTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${ACCOUNT_ERASURE_OPERATION_FENCE_TABLE} (
  operation_hash FixedString(64),
  erased_at DateTime64(9) DEFAULT now64(9)
)
ENGINE = ReplacingMergeTree(erased_at)
ORDER BY operation_hash`;
}
