import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0060_heart_rate_day_change",
    statements: [
      `CREATE TABLE IF NOT EXISTS analytics.heart_rate_day_change (
  user_id UUID,
  recorded_date Date,
  changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (user_id, recorded_date)`,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.heart_rate_day_change_ingest
TO analytics.heart_rate_day_change
AS
SELECT
  user_id,
  recorded_date,
  now64(9, 'UTC') AS changed_at
FROM analytics.deduped_sensor
WHERE channel = 'heart_rate'
GROUP BY user_id, recorded_date`,
      `CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_cutover (
  cutover_at DateTime64(9, 'UTC')
)
ENGINE = TinyLog`,
      `INSERT INTO analytics.sleep_heart_rate_cutover (cutover_at)
SELECT now64(9, 'UTC')
WHERE NOT EXISTS (
  SELECT 1
  FROM analytics.sleep_heart_rate_cutover
)`,
      `CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_window (
  sleep_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at DateTime64(6, 'UTC'),
  duration_seconds Int64,
  eligible_sample_count UInt64,
  source_changed_at DateTime64(9, 'UTC'),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, sleep_id)`,
    ],
  };
}
