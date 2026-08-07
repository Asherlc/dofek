import type { ClickHouseMigration } from "./types.ts";

const dailyEnduranceLoadTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_endurance_load (
  activity_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  date Nullable(Date),
  training_load Float64,
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0039_create_daily_endurance_load_table",
    statements: [dailyEnduranceLoadTableSql],
  };
}
