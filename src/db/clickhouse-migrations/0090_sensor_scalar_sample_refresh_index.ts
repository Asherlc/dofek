import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0090_sensor_scalar_sample_refresh_index",
    statements: [
      "ALTER TABLE analytics.sensor_scalar_sample ADD INDEX IF NOT EXISTS peerdb_synced_at_minmax _peerdb_synced_at TYPE minmax GRANULARITY 1",
      "ALTER TABLE analytics.sensor_scalar_sample MATERIALIZE INDEX peerdb_synced_at_minmax SETTINGS mutations_sync = 2",
    ],
  };
}
