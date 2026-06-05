import type { ClickHouseMigration } from "./types.ts";

const dailyRecoveryTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_recovery (
  user_id UUID,
  date Date,
  hrv Nullable(Float64),
  resting_hr Nullable(Float64),
  respiratory_rate Nullable(Float64),
  efficiency_pct Nullable(Float64),
  hrv_mean_30d Nullable(Float64),
  hrv_sd_30d Nullable(Float64),
  rhr_mean_30d Nullable(Float64),
  rhr_sd_30d Nullable(Float64),
  rr_mean_30d Nullable(Float64),
  rr_sd_30d Nullable(Float64),
  hrv_mean_60d Nullable(Float64),
  hrv_sd_60d Nullable(Float64),
  rhr_mean_60d Nullable(Float64),
  rhr_sd_60d Nullable(Float64),
  hrv_score Nullable(Float64),
  resting_hr_score Nullable(Float64),
  sleep_score Nullable(Float64),
  respiratory_rate_score Nullable(Float64),
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;

const dailyStrainTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_strain (
  user_id UUID,
  date Date,
  daily_load Float64,
  strain Float64,
  acute_load_7d Float64,
  chronic_load_28d Float64,
  workload_ratio Nullable(Float64),
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;

const weeklyHealthspanTableSql = `CREATE TABLE IF NOT EXISTS analytics.weekly_healthspan (
  user_id UUID,
  week_start Date,
  avg_sleep_min Nullable(Float64),
  bedtime_stddev_min Nullable(Float64),
  avg_resting_hr Nullable(Float64),
  avg_steps Nullable(Float64),
  latest_vo2max Nullable(Float64),
  weekly_aerobic_min Float64,
  weekly_high_intensity_min Float64,
  sessions_per_week Nullable(Float64),
  weight_kg Nullable(Float64),
  body_fat_pct Nullable(Float64),
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, week_start)`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0026_create_dashboard_tables",
    statements: [dailyRecoveryTableSql, dailyStrainTableSql, weeklyHealthspanTableSql],
  };
}
