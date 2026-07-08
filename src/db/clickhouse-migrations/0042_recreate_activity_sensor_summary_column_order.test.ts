import { describe, expect, it } from "vitest";
import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
} from "../clickhouse-activity-sensor-summary.ts";
import { createMigration } from "./0042_recreate_activity_sensor_summary_column_order.ts";

describe("0042_recreate_activity_sensor_summary_column_order", () => {
  it("recreates sensor and activity summary tables with canonical column order", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0042_recreate_activity_sensor_summary_column_order");
    expect(migration.statements).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary_rows",
      "DROP TABLE IF EXISTS analytics.activity_sensor_summary_rows",
      buildActivitySensorSummaryRowsTableSql(),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.activity_summary_rows"),
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("keeps power and climbing columns before refresh metadata", () => {
    const columns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());
    const refreshVersionIndex = columns.indexOf("refresh_version");
    const climbingSecondsIndex = columns.indexOf("climbing_seconds");

    expect(refreshVersionIndex).toBeGreaterThan(climbingSecondsIndex);
    expect(columns.slice(-3)).toEqual(["refresh_version", "is_deleted", "refreshed_at"]);
  });
});
