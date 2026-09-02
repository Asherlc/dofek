import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0073_activity_sensor_summary_source_version",
    statements: [
      `ALTER TABLE analytics.activity_sensor_summary_rows
ADD COLUMN IF NOT EXISTS source_refresh_version UInt64 DEFAULT 0 AFTER climbing_seconds`,
      `ALTER TABLE IF EXISTS analytics.activity_sensor_sample
MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild'`,
      `ALTER TABLE IF EXISTS analytics.activity_sensor_sample ADD PROJECTION IF NOT EXISTS by_activity_source_refresh_version (
  SELECT
    activity_id,
    user_id,
    max(refresh_version) AS source_refresh_version
  GROUP BY activity_id, user_id
)`,
    ],
  };
}
