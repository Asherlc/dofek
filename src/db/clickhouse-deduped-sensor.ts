import { METRIC_STREAM_TABLE } from "../metric-stream/clickhouse-table.ts";

const sensorScalarChannels = [
  "heart_rate",
  "power",
  "speed",
  "cadence",
  "altitude",
  "grade",
  "left_right_balance",
  "left_torque_effectiveness",
  "right_torque_effectiveness",
  "left_pedal_smoothness",
  "right_pedal_smoothness",
  "stance_time",
  "vertical_oscillation",
  "ground_contact_time",
  "stride_length",
] as const;

interface RecordedAtRangeSql {
  lowerBound: string;
  upperBound: string;
}

function sensorScalarChannelListSql(): string {
  return sensorScalarChannels.map((channel) => `'${channel}'`).join(",\n      ");
}

function sensorScalarSampleSelectSql(
  sourceTable: string,
  sourceFinalClause: "" | " FINAL",
  recordedAtRange?: RecordedAtRangeSql,
): string {
  return `WITH
metric_stream_rows AS (
  SELECT *
  FROM ${sourceTable}${sourceFinalClause}
  WHERE scalar IS NOT NULL
    AND channel IN (
      ${sensorScalarChannelListSql()}
    )
    ${recordedAtRange ? `AND recorded_at >= ${recordedAtRange.lowerBound}\n    AND recorded_at < ${recordedAtRange.upperBound}` : ""}
),
active_sensor_provider_priority AS (
  SELECT provider_id, channel, priority
  FROM postgres_fitness.sensor_provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_sensor_device_priority AS (
  SELECT provider_id, source_name_pattern, channel, priority
  FROM postgres_fitness.sensor_device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT metric_stream_id, priority
  FROM (
    SELECT
      metric_stream_rows.id AS metric_stream_id,
      active_sensor_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY metric_stream_rows.id
        ORDER BY
          length(active_sensor_device_priority.source_name_pattern) DESC,
          active_sensor_device_priority.priority ASC,
          active_sensor_device_priority.source_name_pattern ASC
      ) AS row_number
    FROM metric_stream_rows
    INNER JOIN active_sensor_device_priority
      ON active_sensor_device_priority.provider_id = metric_stream_rows.provider_id
     AND active_sensor_device_priority.channel = metric_stream_rows.channel
     AND metric_stream_rows.device_id IS NOT NULL
     AND assumeNotNull(metric_stream_rows.device_id) LIKE active_sensor_device_priority.source_name_pattern
  )
  WHERE row_number = 1
)
SELECT
  metric_stream_rows.id AS id,
  metric_stream_rows.user_id AS user_id,
  metric_stream_rows.recorded_at AS recorded_at,
  toDate(metric_stream_rows.recorded_at) AS recorded_date,
  metric_stream_rows.channel AS channel,
  metric_stream_rows.provider_id AS provider_id,
  metric_stream_rows.device_id AS device_id,
  assumeNotNull(metric_stream_rows.scalar) AS scalar,
  coalesce(device_priority_match.priority, active_sensor_provider_priority.priority, 1000) AS provider_priority,
  metric_stream_rows.ingested_at AS _peerdb_synced_at,
  metric_stream_rows.is_deleted AS _peerdb_is_deleted,
  metric_stream_rows.version AS _peerdb_version
FROM metric_stream_rows
LEFT JOIN active_sensor_provider_priority
  ON active_sensor_provider_priority.provider_id = metric_stream_rows.provider_id
 AND active_sensor_provider_priority.channel = metric_stream_rows.channel
LEFT JOIN device_priority_match
  ON device_priority_match.metric_stream_id = metric_stream_rows.id`;
}

function buildSensorScalarSampleTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample (
  id UUID,
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel LowCardinality(String),
  provider_id LowCardinality(String),
  device_id Nullable(String),
  scalar Float32,
  provider_priority UInt16,
  _peerdb_synced_at DateTime64(9),
  _peerdb_is_deleted Int8,
  _peerdb_version Int64
)
ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY (user_id, channel, recorded_date, recorded_at, provider_id, id)`;
}

export function buildSensorScalarSampleBackfillSql(recordedAtRange?: RecordedAtRangeSql): string {
  return `INSERT INTO analytics.sensor_scalar_sample (
  id,
  user_id,
  recorded_at,
  recorded_date,
  channel,
  provider_id,
  device_id,
  scalar,
  provider_priority,
  _peerdb_synced_at,
  _peerdb_is_deleted,
  _peerdb_version
)
${sensorScalarSampleSelectSql(METRIC_STREAM_TABLE, " FINAL", recordedAtRange)}`;
}

function buildDedupedSensorTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.deduped_sensor (
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel LowCardinality(String),
  scalar Nullable(Float32),
  provider_id Nullable(String),
  source_metric_stream_id Nullable(UUID),
  provider_priority UInt16,
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9)
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, channel, recorded_date, recorded_at)`;
}

export function buildDedupedSensorRecomputeInsertSql(pendingKeySql: string): string {
  return `INSERT INTO analytics.deduped_sensor (
  user_id,
  recorded_at,
  recorded_date,
  channel,
  scalar,
  provider_id,
  source_metric_stream_id,
  provider_priority,
  refresh_version,
  is_deleted,
  refreshed_at
)
WITH pending_keys AS (
  ${pendingKeySql}
)
SELECT
  pending_keys.user_id AS user_id,
  pending_keys.recorded_at AS recorded_at,
  toDate(pending_keys.recorded_at) AS recorded_date,
  pending_keys.channel AS channel,
  argMinIf(samples.scalar, (samples.provider_priority, samples.provider_id, samples.id), samples._peerdb_is_deleted = 0) AS scalar,
  argMinIf(samples.provider_id, (samples.provider_priority, samples.provider_id, samples.id), samples._peerdb_is_deleted = 0) AS provider_id,
  argMinIf(samples.id, (samples.provider_priority, samples.provider_id, samples.id), samples._peerdb_is_deleted = 0) AS source_metric_stream_id,
  coalesce(minIf(samples.provider_priority, samples._peerdb_is_deleted = 0), 65535) AS provider_priority,
  toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
  if(countIf(samples._peerdb_is_deleted = 0) = 0, 1, 0) AS is_deleted,
  now64(9) AS refreshed_at
FROM pending_keys
LEFT JOIN (
  SELECT *
  FROM analytics.sensor_scalar_sample FINAL
  WHERE (user_id, channel, recorded_at) IN (
    SELECT user_id, channel, recorded_at
    FROM pending_keys
  )
) AS samples
  ON samples.user_id = pending_keys.user_id
 AND samples.channel = pending_keys.channel
 AND samples.recorded_at = pending_keys.recorded_at
GROUP BY pending_keys.user_id, pending_keys.channel, pending_keys.recorded_at`;
}

export function buildDedupedSensorBackfillSql(recordedAtRange?: RecordedAtRangeSql): string {
  return buildDedupedSensorRecomputeInsertSql(`SELECT DISTINCT
    user_id,
    channel,
    recorded_at
  FROM analytics.sensor_scalar_sample FINAL${
    recordedAtRange
      ? `\n  WHERE recorded_at >= ${recordedAtRange.lowerBound}\n    AND recorded_at < ${recordedAtRange.upperBound}`
      : ""
  }`);
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
