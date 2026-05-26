export function buildActivityVo2MaxEstimateTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.activity_vo2max_estimate (
  activity_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  method LowCardinality(String),
  vo2max Float64,
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, started_at, activity_id, method)`;
}
