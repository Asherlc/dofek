export function buildProviderStatsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.provider_stats (
  user_id UUID,
  provider_id String,
  activities UInt64,
  daily_metrics UInt64,
  sleep_sessions UInt64,
  body_measurements UInt64,
  food_entries UInt64,
  health_events UInt64,
  metric_stream UInt64,
  nutrition_daily UInt64,
  clinical_records UInt64,
  journal_entries UInt64,
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, provider_id)`;
}
