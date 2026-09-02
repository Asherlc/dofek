import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0072_activity_sensor_summary_source_version",
    statements: [
      `ALTER TABLE analytics.activity_sensor_summary_rows
ADD COLUMN IF NOT EXISTS source_refresh_version UInt64 DEFAULT 0 BEFORE refresh_version`,
    ],
  };
}
