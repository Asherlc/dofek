import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0117_cycling_polarization_elapsed_seconds",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics.activity_cycling_polarization (
        activity_id UUID,
        user_id UUID,
        canonical_type String,
        started_at DateTime64(6, 'UTC'),
        max_hr Nullable(Int16),
        z1_microseconds UInt64,
        z2_microseconds UInt64,
        z3_microseconds UInt64,
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9),
        ended_at DateTime64(6, 'UTC'),
        source_sensor_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`,
    ],
  };
}
