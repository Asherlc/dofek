import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0092_sensor_scalar_sample_refresh_projection",
    statements: [
      `ALTER TABLE analytics.sensor_scalar_sample
        MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild'`,
      `ALTER TABLE analytics.sensor_scalar_sample
        MODIFY SETTING lightweight_mutation_projection_mode = 'rebuild'`,
      `ALTER TABLE analytics.sensor_scalar_sample
        ADD PROJECTION IF NOT EXISTS by_peerdb_synced_at (
          SELECT *
          ORDER BY _peerdb_synced_at
        )`,
      `ALTER TABLE analytics.sensor_scalar_sample
        MATERIALIZE PROJECTION by_peerdb_synced_at SETTINGS mutations_sync = 2`,
    ],
  };
}
