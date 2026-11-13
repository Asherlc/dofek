import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0111_daily_health_sensor",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics.daily_health_sensor (
      user_id UUID,
      provider_id String,
      recorded_date Date,
      samples Array(Tuple(
        id UUID, measured_at DateTime64(6, 'UTC'), channel String,
        source_name Nullable(String), value Float64
      )),
      source_changed_at DateTime64(9, 'UTC'),
      refresh_version UInt64,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE=ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, provider_id, recorded_date)`,
    ],
  };
}
