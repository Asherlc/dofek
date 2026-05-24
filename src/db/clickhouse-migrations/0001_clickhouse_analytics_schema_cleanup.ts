import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0001_clickhouse_analytics_schema_cleanup",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.deduped_sensor",
      "DROP VIEW IF EXISTS fitness.activity_summary",
      "DROP TABLE IF EXISTS fitness.activity_summary",
      "DROP TABLE IF EXISTS fitness.deduped_sensor",
      "DROP TABLE IF EXISTS fitness.activity_sensor_window",
      "DROP TABLE IF EXISTS fitness.metric_stream_sync_log",
      "DROP TABLE IF EXISTS fitness.metric_stream",
    ],
  };
}
