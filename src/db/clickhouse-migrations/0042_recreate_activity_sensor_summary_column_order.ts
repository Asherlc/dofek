import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
} from "../clickhouse-activity-sensor-summary.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

const sensorSummaryTable = "analytics.activity_sensor_summary_rows";
const activitySummaryTable = "analytics.activity_summary_rows";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0042_recreate_activity_sensor_summary_column_order",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `RENAME TABLE ${sensorSummaryTable} TO ${sensorSummaryTable}_old,
                    ${activitySummaryTable} TO ${activitySummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      ...makeCopyStatements(),
      `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
      buildActivitySummaryViewSql(),
    ],
  };
}

function makeCopyStatements(): string[] {
  const sensorColumns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());
  const summaryColumns = extractClickHouseTableColumnNames(buildActivitySummaryRowsTableSql());

  const sensorColumnsList = sensorColumns.join(", ");
  const summaryColumnsList = summaryColumns.join(", ");

  return [
    `INSERT INTO ${sensorSummaryTable} (${sensorColumnsList}) SELECT ${sensorColumnsList} FROM ${sensorSummaryTable}_old`,
    `INSERT INTO ${activitySummaryTable} (${summaryColumnsList}) SELECT ${summaryColumnsList} FROM ${activitySummaryTable}_old`,
  ];
}
