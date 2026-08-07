import { standardViewHeader } from "./clickhouse-sql-helpers.ts";

export function buildActivitySummaryRowsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.activity_summary_rows (
  activity_id UUID,
  user_id UUID,
  canonical_type Nullable(String),
  provider_type Nullable(String),
  modality Nullable(String),
  name Nullable(String),
  started_at Nullable(DateTime64(6, 'UTC')),
  ended_at Nullable(DateTime64(6, 'UTC')),
  avg_hr Nullable(Float64),
  max_hr Nullable(Int16),
  min_hr Nullable(Int16),
  avg_power Nullable(Float64),
  max_power Nullable(Int16),
  avg_speed Nullable(Float64),
  max_speed Nullable(Float64),
  avg_cadence Nullable(Float64),
  elevation_gain_legacy Nullable(Float64),
  total_distance Nullable(Float64),
  centroid_lat Nullable(Float64),
  centroid_lng Nullable(Float64),
  avg_left_balance Nullable(Float64),
  avg_left_torque_eff Nullable(Float64),
  avg_right_torque_eff Nullable(Float64),
  avg_left_pedal_smooth Nullable(Float64),
  avg_right_pedal_smooth Nullable(Float64),
  elevation_gain_m Nullable(Float64),
  elevation_loss_m Nullable(Float64),
  avg_stance_time Nullable(Float64),
  avg_vertical_osc Nullable(Float64),
  avg_ground_contact_time Nullable(Float64),
  avg_stride_length Nullable(Float64),
  sample_count Nullable(UInt64),
  hr_sample_count Nullable(UInt64),
  power_sample_count Nullable(UInt64),
  first_sample_at Nullable(DateTime64(6, 'UTC')),
  last_sample_at Nullable(DateTime64(6, 'UTC')),
  best_twenty_minute_power Nullable(Float64),
  normalized_power Nullable(Float64),
  smoothed_avg_power Nullable(Float64),
  climbing_elevation_gain_m Nullable(Float64),
  climbing_seconds Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

export function buildActivitySummaryViewSql(): string {
  return `${standardViewHeader("analytics.activity_summary")}
SELECT
  activity_id,
  user_id,
  assumeNotNull(canonical_type) AS canonical_type,
  provider_type,
  modality,
  name,
  assumeNotNull(started_at) AS started_at,
  ended_at,
  avg_hr,
  max_hr,
  min_hr,
  avg_power,
  max_power,
  avg_speed,
  max_speed,
  avg_cadence,
  elevation_gain_legacy,
  total_distance,
  centroid_lat,
  centroid_lng,
  avg_left_balance,
  avg_left_torque_eff,
  avg_right_torque_eff,
  avg_left_pedal_smooth,
  avg_right_pedal_smooth,
  elevation_gain_m,
  elevation_loss_m,
  avg_stance_time,
  avg_vertical_osc,
  avg_ground_contact_time,
  avg_stride_length,
  sample_count,
  hr_sample_count,
  power_sample_count,
  first_sample_at,
  last_sample_at,
  best_twenty_minute_power,
  normalized_power,
  smoothed_avg_power,
  climbing_elevation_gain_m,
  climbing_seconds,
  refreshed_at
FROM analytics.activity_summary_rows FINAL
WHERE is_deleted = 0`;
}

export function buildIncrementalActivitySummaryStatements(): string[] {
  return [buildActivitySummaryRowsTableSql(), buildActivitySummaryViewSql()];
}
