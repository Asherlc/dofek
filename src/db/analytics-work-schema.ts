export function analyticsWorkSchemaStatements(): string[] {
  const delivery = `epoch String, topic String, partition Int32,
    major UInt64, minor UInt64, batch Int32`;
  return [
    `CREATE TABLE IF NOT EXISTS analytics.effect_journal (
      ${delivery}, effect_ordinal UInt64, stage Enum8('scalar'=1,'dedup'=2,'activity'=3),
      serialized_message_id String, operation_id Nullable(UUID), user_id UUID,
      source_id UUID, source_version UInt64, generation UInt64,
      before Nullable(String), after Nullable(String), effect_hash FixedString(64)
    ) ENGINE=ReplacingMergeTree
    ORDER BY (epoch,topic,partition,major,minor,batch,effect_ordinal,stage)`,
    `CREATE TABLE IF NOT EXISTS analytics.effect_receipt (
      ${delivery}, effect_ordinal Int128, stage Enum8('scalar'=1,'dedup'=2,'activity'=3),
      effect_hash FixedString(64), is_empty UInt8, user_id Nullable(UUID)
    ) ENGINE=ReplacingMergeTree
    ORDER BY (epoch,topic,partition,major,minor,batch,effect_ordinal,stage)`,
    `CREATE TABLE IF NOT EXISTS analytics.delivery_receipt (
      ${delivery}, serialized_message_id String, effect_count UInt64, chunk_count UInt64,
      effect_digest FixedString(64), stages Array(String)
    ) ENGINE=ReplacingMergeTree ORDER BY (epoch,topic,partition,major,minor,batch)`,
    `CREATE TABLE IF NOT EXISTS analytics.source_placement (
      source_id UUID, user_id UUID, provider_id String, source_version UInt64, generation UInt64,
      channel String, recorded_at DateTime64(9,'UTC'), activity_id Nullable(UUID), deleted UInt8
    ) ENGINE=ReplacingMergeTree(source_version) ORDER BY (source_id,user_id)`,
  ];
}
