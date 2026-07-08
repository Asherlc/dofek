import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
  extractDbtFinalSelectColumnNames,
} from "./clickhouse-activity-sensor-summary.ts";

const modelSql = readFileSync(
  new URL("../../analytics/models/read_models/activity_sensor_summary_rows.sql", import.meta.url),
  "utf8",
);

describe("clickhouse-activity-sensor-summary", () => {
  it("keeps refresh metadata after power and climbing columns", () => {
    const columns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());

    expect(columns.at(-3)).toBe("refresh_version");
    expect(columns.at(-2)).toBe("is_deleted");
    expect(columns.at(-1)).toBe("refreshed_at");
    expect(columns.indexOf("climbing_seconds")).toBeLessThan(columns.indexOf("refresh_version"));
  });

  it("parses the dbt model final SELECT aliases in table order", () => {
    const tableColumns = extractClickHouseTableColumnNames(
      buildActivitySensorSummaryRowsTableSql(),
    );
    const selectColumns = extractDbtFinalSelectColumnNames(modelSql, "dirty_keys");

    expect(selectColumns).toEqual(tableColumns);
  });
});
