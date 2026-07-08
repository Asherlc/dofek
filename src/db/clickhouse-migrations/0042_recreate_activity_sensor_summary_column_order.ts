import { buildActivitySensorSummaryRowsTableSql } from "../clickhouse-activity-sensor-summary.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0042_recreate_activity_sensor_summary_column_order",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary_rows",
      "DROP TABLE IF EXISTS analytics.activity_sensor_summary_rows",
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      buildActivitySummaryViewSql(),
    ],
  };
}
