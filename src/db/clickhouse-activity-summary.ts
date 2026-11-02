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
  cadence_basis String DEFAULT 'unknown',
  cadence_observed_seconds Nullable(Float64),
  cadence_coverage_percent Nullable(Float64),
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
  return `CREATE OR REPLACE VIEW analytics.activity_summary
AS
SELECT
  summary.activity_id,
  summary.user_id,
  assumeNotNull(summary.canonical_type) AS canonical_type,
  summary.provider_type,
  summary.modality,
  summary.name,
  assumeNotNull(summary.started_at) AS started_at,
  summary.ended_at,
  summary.avg_hr,
  summary.max_hr,
  summary.min_hr,
  summary.avg_power,
  summary.max_power,
  summary.avg_speed,
  summary.max_speed,
  summary.avg_cadence,
  summary.cadence_basis,
  summary.cadence_observed_seconds,
  summary.cadence_coverage_percent,
  summary.elevation_gain_legacy,
  summary.total_distance,
  summary.centroid_lat,
  summary.centroid_lng,
  summary.avg_left_balance,
  summary.avg_left_torque_eff,
  summary.avg_right_torque_eff,
  summary.avg_left_pedal_smooth,
  summary.avg_right_pedal_smooth,
  summary.elevation_gain_m,
  summary.elevation_loss_m,
  summary.avg_stance_time,
  summary.avg_vertical_osc,
  summary.avg_ground_contact_time,
  summary.avg_stride_length,
  summary.sample_count,
  summary.hr_sample_count,
  summary.power_sample_count,
  summary.first_sample_at,
  summary.last_sample_at,
  summary.best_twenty_minute_power,
  if(power.is_deleted = 0 AND power.source_refresh_version >= summary.refresh_version,
    power.normalized_power, CAST(NULL, 'Nullable(Float64)')) AS normalized_power,
  summary.smoothed_avg_power,
  summary.climbing_elevation_gain_m,
  summary.climbing_seconds,
  summary.refreshed_at
FROM analytics.activity_summary_rows AS summary FINAL
LEFT JOIN analytics.cycling_power_observation_rows AS power FINAL
  ON power.user_id = summary.user_id AND power.activity_id = summary.activity_id
WHERE summary.is_deleted = 0`;
}

export function buildIncrementalActivitySummaryStatements(): string[] {
  return [buildActivitySummaryRowsTableSql(), buildActivitySummaryViewSql()];
}
