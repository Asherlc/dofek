function buildSensorScalarSampleTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample (
  id UUID,
  activity_id Nullable(UUID),
  member_activity_id Nullable(UUID),
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel LowCardinality(String),
  provider_id LowCardinality(String),
  source_external_id Nullable(String),
  device_id Nullable(String),
  source_type Nullable(String),
  measurement_kind LowCardinality(String),
  scalar Float32,
  provider_priority Int32,
  _peerdb_synced_at DateTime64(9),
  _peerdb_is_deleted Int8,
  _peerdb_version Int64,
  refresh_version UInt64
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, channel, recorded_date, recorded_at, provider_id, id)`;
}

function buildDedupedSensorTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.deduped_sensor (
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel LowCardinality(String),
  scalar Nullable(Float32),
  provider_id Nullable(String),
  member_activity_id Nullable(UUID),
  device_id Nullable(String),
  source_external_id Nullable(String),
  source_type Nullable(String),
  measurement_kind LowCardinality(String),
  source_metric_stream_id Nullable(UUID),
  source_activity_id Nullable(UUID),
  provider_priority Int32,
  source_refreshed_at DateTime64(9),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9)
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, channel, recorded_date, recorded_at)`;
}

export function buildIncrementalDedupedSensorStatements(): string[] {
  return [buildSensorScalarSampleTableSql(), buildDedupedSensorTableSql()];
}

export function buildIncrementalDedupedSensorResetStatements(): string[] {
  return [
    "DROP TABLE IF EXISTS analytics.sensor_scalar_sample_ingest",
    "DROP TABLE IF EXISTS analytics.sensor_dirty_key_ingest",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.sensor_dirty_key",
    "DROP TABLE IF EXISTS analytics.sensor_scalar_sample",
  ];
}

export function buildIncrementalDedupedSensorBaseTableStatements(): string[] {
  return [buildSensorScalarSampleTableSql(), buildDedupedSensorTableSql()];
}

export function buildIncrementalDedupedSensorIngestStatements(): string[] {
  return [];
}

export function buildIncrementalDedupedSensorMigrationStatements(): string[] {
  return [
    ...buildIncrementalDedupedSensorResetStatements(),
    ...buildIncrementalDedupedSensorBaseTableStatements(),
    ...buildIncrementalDedupedSensorIngestStatements(),
  ];
}
