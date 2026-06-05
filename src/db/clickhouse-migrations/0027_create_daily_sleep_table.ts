import type { ClickHouseMigration } from "./types.ts";

const dailySleepTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_sleep (
  user_id UUID,
  date Date,
  provider_id String,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_minutes Nullable(Int32),
  deep_minutes Nullable(Int32),
  rem_minutes Nullable(Int32),
  light_minutes Nullable(Int32),
  awake_minutes Nullable(Int32),
  efficiency_pct Nullable(Float64),
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0027_create_daily_sleep_table",
    statements: [dailySleepTableSql],
  };
}
