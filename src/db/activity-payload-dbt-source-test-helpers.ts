export function createActivitySourceRecordsSql(database: string): string {
  return `CREATE TABLE ${database}.activity_source_records (
    activity_id UUID,
    group_id Nullable(UUID),
    provider_id Nullable(String),
    user_id Nullable(UUID),
    external_id Nullable(String),
    canonical_type Nullable(String),
    provider_type Nullable(String),
    modality Nullable(String),
    started_at Nullable(DateTime64(6, 'UTC')),
    ended_at Nullable(DateTime64(6, 'UTC')),
    source_name Nullable(String),
    name Nullable(String),
    notes Nullable(String),
    timezone Nullable(String),
    start_utc_offset_minutes Nullable(Int16),
    end_utc_offset_minutes Nullable(Int16),
    local_time_source LowCardinality(String),
    raw Nullable(String),
    source_synced_at Nullable(DateTime64(9, 'UTC')),
    priority Nullable(Int32),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`;
}

export function createSourceActivitySql(database: string): string {
  return `CREATE TABLE ${database}.activity (
    id UUID,
    group_id Nullable(UUID),
    provider_id Nullable(String),
    user_id UUID,
    external_id Nullable(String),
    provider_absent_at Nullable(DateTime64(6, 'UTC')),
    raw Nullable(String),
    source_name Nullable(String),
    deleted_at Nullable(DateTime64(6, 'UTC')),
    _peerdb_is_deleted Int8,
    _peerdb_version Int64,
    created_at DateTime64(6, 'UTC') DEFAULT now64(6)
  ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`;
}

export function createProducerDedupedSensorSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    recorded_date Date,
    channel String,
    scalar Nullable(Float64),
    provider_id Nullable(String),
    member_activity_id Nullable(UUID),
    device_id Nullable(String),
    source_external_id Nullable(String),
    source_type Nullable(String),
    measurement_kind LowCardinality(String),
    source_metric_stream_id Nullable(UUID),
    source_activity_id Nullable(UUID),
    provider_priority Int32,
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, channel, recorded_at)`;
}
