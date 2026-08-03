import { buildProviderStatsTableSql } from "../clickhouse-provider-stats.ts";
import type { ClickHouseMigration } from "./types.ts";

const dailyRecoveryInputsTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_recovery_inputs (
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
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, date)`;

const dailyActivityLoadTableSql = `CREATE TABLE IF NOT EXISTS analytics.daily_activity_load (
  activity_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  daily_load Nullable(Float64),
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;

const healthspanActivityZoneMinutesTableSql = `CREATE TABLE IF NOT EXISTS analytics.healthspan_activity_zone_minutes (
  activity_id UUID,
  user_id UUID,
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  aerobic_minutes Float64,
  high_intensity_minutes Float64,
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;

export const dedupedActivitiesTableSql = `CREATE TABLE IF NOT EXISTS analytics.deduped_activities (
  activity_id UUID,
  provider_id String,
  user_id UUID,
  primary_activity_id UUID,
  activity_type String,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_name Nullable(String),
  name Nullable(String),
  notes Nullable(String),
  timezone Nullable(String),
  start_utc_offset_minutes Nullable(Int16),
  end_utc_offset_minutes Nullable(Int16),
  local_time_source LowCardinality(String) DEFAULT 'unknown',
  raw Nullable(String),
  source_synced_at DateTime64(9, 'UTC'),
  source_providers Array(String),
  source_external_ids Array(Map(String, String)),
  absent_source_external_ids Array(Map(String, String)),
  member_activity_ids Array(UUID),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0024_create_dbt_serving_read_model_tables",
    statements: [
      dailyRecoveryInputsTableSql,
      dailyActivityLoadTableSql,
      healthspanActivityZoneMinutesTableSql,
      dedupedActivitiesTableSql,
      "DROP VIEW IF EXISTS analytics.provider_stats",
      "DROP TABLE IF EXISTS analytics.provider_stats",
      buildProviderStatsTableSql(),
    ],
  };
}
