import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0094_sensor_scalar_sample_lightweight_refresh_projection",
    statements: [
      `ALTER TABLE analytics.sensor_scalar_sample
        DROP PROJECTION IF EXISTS by_peerdb_synced_at
        SETTINGS mutations_sync = 2`,
      `ALTER TABLE analytics.sensor_scalar_sample
        ADD PROJECTION IF NOT EXISTS by_peerdb_synced_at (
          SELECT _part_offset
          ORDER BY _peerdb_synced_at
        )`,
      `ALTER TABLE analytics.sensor_scalar_sample
        MATERIALIZE PROJECTION by_peerdb_synced_at SETTINGS mutations_sync = 2`,
    ],
  };
}
