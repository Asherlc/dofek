export const INGEST_DATABASE = "ingest";
export const METRIC_STREAM_TABLE = `${INGEST_DATABASE}.metric_stream`;
export const LEGACY_METRIC_STREAM_TABLE = "postgres_fitness.metric_stream";
export const METRIC_STREAM_ORDER_BY = "(user_id, activity_id, channel, recorded_at, id)";

export const metricStreamIngestMetadataColumnDefinitions = `  ingested_at DateTime64(9) DEFAULT now(),
  is_deleted Int8 DEFAULT 0,
  version Int64 DEFAULT 0`;

export function metricStreamReplacingMergeTreeEngine(): string {
  return `ENGINE = ReplacingMergeTree(version)
ORDER BY ${METRIC_STREAM_ORDER_BY}
SETTINGS allow_nullable_key = 1`;
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
${metricStreamIngestMetadataColumnDefinitions}
)
${metricStreamReplacingMergeTreeEngine()}`;
}
