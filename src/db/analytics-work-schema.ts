export function analyticsWorkSchemaStatements(): string[] {
  const delivery = `epoch String, topic String, partition Int32,
    transport Enum8('pulsar'=1,'kafka'=2) DEFAULT 'pulsar', kafka_offset UInt64 DEFAULT 0,
    major UInt64, minor UInt64, batch Int32,
    CONSTRAINT canonical_transport_coordinates CHECK
      ((transport='pulsar' AND kafka_offset=0)
       OR (transport='kafka' AND major=0 AND minor=0 AND batch=-1))`;
  return [
    `CREATE TABLE IF NOT EXISTS analytics.effect_journal (
      ${delivery}, effect_ordinal UInt64, stage Enum8('scalar'=1,'dedup'=2,'activity'=3),
      serialized_message_id String, operation_id Nullable(UUID), user_id UUID,
      source_id UUID, source_version UInt64, generation UInt64,
      before Nullable(String), after Nullable(String), effect_hash FixedString(64),
      CONSTRAINT canonical_message_identity CHECK
        ((transport='pulsar' AND serialized_message_id!='')
         OR (transport='kafka' AND serialized_message_id=''))
    ) ENGINE=ReplacingMergeTree
    ORDER BY (epoch,topic,partition,transport,kafka_offset,major,minor,batch,effect_ordinal,stage)
    SETTINGS storage_policy='metric_stream_journal'`,
    `CREATE TABLE IF NOT EXISTS analytics.effect_receipt (
      ${delivery}, effect_ordinal Int128, stage Enum8('scalar'=1,'dedup'=2,'activity'=3),
      effect_hash FixedString(64), is_empty UInt8, user_id Nullable(UUID)
    ) ENGINE=ReplacingMergeTree
    ORDER BY (epoch,topic,partition,transport,kafka_offset,major,minor,batch,effect_ordinal,stage)
    SETTINGS storage_policy='metric_stream_journal'`,
    `CREATE TABLE IF NOT EXISTS analytics.delivery_receipt (
      ${delivery}, serialized_message_id String, effect_count UInt64, chunk_count UInt64,
      effect_digest FixedString(64), stages Array(String),
      status Enum8('prepared'=1,'committed'=2) DEFAULT 'committed',
      CONSTRAINT canonical_message_identity CHECK
        ((transport='pulsar' AND serialized_message_id!='')
         OR (transport='kafka' AND serialized_message_id=''))
    ) ENGINE=ReplacingMergeTree
    ORDER BY (epoch,topic,partition,transport,kafka_offset,major,minor,batch,status)
    SETTINGS storage_policy='metric_stream_journal'`,
    `CREATE TABLE IF NOT EXISTS analytics.source_placement (
      source_id UUID, user_id UUID, provider_id String, source_version UInt64, generation UInt64,
      channel String, recorded_at DateTime64(9,'UTC'), ingested_at DateTime64(9,'UTC'),
      activity_id Nullable(UUID), deleted UInt8,
      PROJECTION by_provider_generation (SELECT source_id,user_id,provider_id,generation,deleted
        ORDER BY (user_id,provider_id,generation,source_id,deleted)),
      PROJECTION by_user_channel_recorded_at (SELECT user_id,channel,recorded_at,source_id
        ORDER BY (user_id,channel,recorded_at,source_id))
    ) ENGINE=ReplacingMergeTree
    ORDER BY (source_id,source_version,ingested_at,user_id,provider_id,generation,
      channel,recorded_at,ifNull(toString(activity_id),''),deleted)
    SETTINGS deduplicate_merge_projection_mode='rebuild',storage_policy='metric_stream_journal'`,
  ];
}
