import type { ClickHouseMigration } from "./types.ts";

const weeklyEnduranceRampRateTableSql = `CREATE TABLE IF NOT EXISTS analytics.weekly_endurance_ramp_rate (
  user_id UUID,
  week Date,
  ctl_start Float64,
  ctl_end Float64,
  ramp_rate Float64,
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, week)`;

const weeklyTrainingMonotonyTableSql = `CREATE TABLE IF NOT EXISTS analytics.weekly_training_monotony (
  user_id UUID,
  week Date,
  monotony Float64,
  strain Float64,
  weekly_load Float64,
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, week)`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0040_create_weekly_endurance_training_tables",
    statements: [weeklyEnduranceRampRateTableSql, weeklyTrainingMonotonyTableSql],
  };
}
