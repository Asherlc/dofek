import { buildActivitySummaryViewSql } from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0035_activity_summary_power_climbing_columns",
    statements: [
      "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS best_twenty_minute_power Nullable(Float64) AFTER last_sample_at",
      "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS normalized_power Nullable(Float64) AFTER best_twenty_minute_power",
      "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS smoothed_avg_power Nullable(Float64) AFTER normalized_power",
      "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS climbing_elevation_gain_m Nullable(Float64) AFTER smoothed_avg_power",
      "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS climbing_seconds Nullable(Int32) AFTER climbing_elevation_gain_m",
      "DROP VIEW IF EXISTS analytics.activity_summary",
      buildActivitySummaryViewSql(),
    ],
  };
}
