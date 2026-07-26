import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0055_provider_connection_catalog",
    statements: [
      `ALTER TABLE postgres_fitness.provider
        MODIFY COLUMN user_id Nullable(UUID)`,
      `CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection (
        user_id UUID,
        provider_id String,
        created_at DateTime64(6, 'UTC'),
        updated_at DateTime64(6, 'UTC'),
        _peerdb_synced_at DateTime64(9) DEFAULT now(),
        _peerdb_is_deleted Int8 DEFAULT 0,
        _peerdb_version Int64 DEFAULT 0
      )
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (user_id, provider_id)`,
    ],
  };
}
