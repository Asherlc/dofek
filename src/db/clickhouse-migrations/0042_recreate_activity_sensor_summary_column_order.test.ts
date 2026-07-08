import { describe, expect, it } from "vitest";
import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
} from "../clickhouse-activity-sensor-summary.ts";
import { buildActivitySummaryRowsTableSql } from "../clickhouse-activity-summary.ts";
import { createMigration } from "./0042_recreate_activity_sensor_summary_column_order.ts";

const sensorSummaryTable = "analytics.activity_sensor_summary_rows";
const activitySummaryTable = "analytics.activity_summary_rows";

describe("0042_recreate_activity_sensor_summary_column_order", () => {
  it("renames old tables to preserve data, then recreates and copies", () => {
    const migration = createMigration();
    const sensorColumns = extractClickHouseTableColumnNames(
      buildActivitySensorSummaryRowsTableSql(),
    );
    const summaryColumns = extractClickHouseTableColumnNames(buildActivitySummaryRowsTableSql());

    expect(migration.id).toBe("0042_recreate_activity_sensor_summary_column_order");
    expect(migration.run).toBeDefined();
    expect(migration.statements).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `RENAME TABLE ${sensorSummaryTable} TO ${sensorSummaryTable}_old,
                    ${activitySummaryTable} TO ${activitySummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      `INSERT INTO ${sensorSummaryTable} (${sensorColumns.join(", ")}) SELECT ${sensorColumns.join(", ")} FROM ${sensorSummaryTable}_old`,
      `INSERT INTO ${activitySummaryTable} (${summaryColumns.join(", ")}) SELECT ${summaryColumns.join(", ")} FROM ${activitySummaryTable}_old`,
      `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  describe("canonical column order", () => {
    it("keeps sensor summary power and climbing columns before refresh metadata", () => {
      const columns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());
      const refreshVersionIndex = columns.indexOf("refresh_version");
      const climbingSecondsIndex = columns.indexOf("climbing_seconds");

      expect(refreshVersionIndex).toBeGreaterThan(climbingSecondsIndex);
      expect(columns.slice(-3)).toEqual(["refresh_version", "is_deleted", "refreshed_at"]);
    });

    it("keeps activity summary power and climbing columns before refresh metadata", () => {
      const columns = extractClickHouseTableColumnNames(buildActivitySummaryRowsTableSql());
      const refreshVersionIndex = columns.indexOf("refresh_version");
      const climbingSecondsIndex = columns.indexOf("climbing_seconds");

      expect(refreshVersionIndex).toBeGreaterThan(climbingSecondsIndex);
      expect(columns.slice(-3)).toEqual(["refresh_version", "is_deleted", "refreshed_at"]);
    });
  });
});
