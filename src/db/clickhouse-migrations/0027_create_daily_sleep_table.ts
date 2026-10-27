import type { ClickHouseMigration } from "./types.ts";

const dailySleepTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_sleep (
  user_id UUID,
  date Date,
  provider_id String,
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String) DEFAULT 'unknown',
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  duration_minutes Nullable(Int32),
  deep_minutes Nullable(Int32),
  rem_minutes Nullable(Int32),
  light_minutes Nullable(Int32),
  awake_minutes Nullable(Int32),
  efficiency_pct Nullable(Float64),
  refresh_version UInt64,
  is_deleted UInt8 DEFAULT 0,
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
