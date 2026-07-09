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
  describe("buildActivitySensorSummaryRowsTableSql", () => {
    it("keeps refresh metadata after power and climbing columns", () => {
      const columns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());

      expect(columns.at(-3)).toBe("refresh_version");
      expect(columns.at(-2)).toBe("is_deleted");
      expect(columns.at(-1)).toBe("refreshed_at");
      expect(columns.indexOf("climbing_seconds")).toBeLessThan(columns.indexOf("refresh_version"));
    });
  });

  describe("extractClickHouseTableColumnNames", () => {
    it("parses the dbt model final SELECT aliases in table order", () => {
      const tableColumns = extractClickHouseTableColumnNames(
        buildActivitySensorSummaryRowsTableSql(),
      );
      const selectColumns = extractDbtFinalSelectColumnNames(modelSql, "dirty_keys");

      expect(selectColumns).toEqual(tableColumns);
    });

    it("throws when the SQL has no matching ENGINE clause", () => {
      expect(() => extractClickHouseTableColumnNames("CREATE TABLE foo (id UInt64)")).toThrow(
        "Could not parse ClickHouse CREATE TABLE column list",
      );
    });

    it("throws when the column body is empty", () => {
      expect(() =>
        extractClickHouseTableColumnNames("CREATE TABLE foo () ENGINE = ReplacingMergeTree()"),
      ).toThrow("Could not parse ClickHouse CREATE TABLE column list");
    });

    it("filters out blank lines between column definitions", () => {
      const sql = `CREATE TABLE foo (\n  id UInt64,\n\n  name String\n) ENGINE = ReplacingMergeTree(ver)`;
      expect(extractClickHouseTableColumnNames(sql)).toEqual(["id", "name"]);
    });

    it("filters out SQL comments between column definitions", () => {
      const sql = `CREATE TABLE foo (\n  id UInt64,\n  -- model-owned lifecycle columns\n  name String\n) ENGINE = ReplacingMergeTree(ver)`;
      expect(extractClickHouseTableColumnNames(sql)).toEqual(["id", "name"]);
    });

    it("returns only column names from complex type definitions", () => {
      const sql = `CREATE TABLE foo (\n  avg_hr Nullable(Float64),\n  tags Nested(key String, val Int32)\n) ENGINE = ReplacingMergeTree(ver)`;
      const columns = extractClickHouseTableColumnNames(sql);
      expect(columns).toEqual(["avg_hr", "tags"]);
    });
  });

  describe("extractDbtFinalSelectColumnNames", () => {
    it("extracts aliases from a minimal SELECT query", () => {
      const sql = "\nSELECT\n  t.col1 AS a,\n  t.col2 AS b\nFROM data\n";
      expect(extractDbtFinalSelectColumnNames(sql, "data")).toEqual(["a", "b"]);
    });

    it("skips blank lines in the SELECT body", () => {
      const sql = "\nSELECT\n  t.col1 AS a,\n\n  t.col2 AS b\nFROM data\n";
      expect(extractDbtFinalSelectColumnNames(sql, "data")).toEqual(["a", "b"]);
    });

    it("allows whitespace before the FROM table", () => {
      const sql = "\nSELECT\n  t.col1 AS a,\n  t.col2 AS b\nFROM   data\n";
      expect(extractDbtFinalSelectColumnNames(sql, "data")).toEqual(["a", "b"]);
    });

    it("matches uppercase unquoted FROM table names", () => {
      const sql = "\nSELECT\n  t.col1 AS a,\n  t.col2 AS b\nFROM DATA\n";
      expect(extractDbtFinalSelectColumnNames(sql, "data")).toEqual(["a", "b"]);
    });

    it("ignores FROM table mentions inside comments and string literals", () => {
      const sql = `
-- SELECT bad.col AS bad_alias FROM data
SELECT 'FROM data' AS string_literal
FROM ignored

SELECT
  t.col1 AS a,
  t.col2 AS b
FROM data
`;
      expect(extractDbtFinalSelectColumnNames(sql, "data")).toEqual(["a", "b"]);
    });

    it("rejects invalid FROM table names", () => {
      expect(() =>
        extractDbtFinalSelectColumnNames("\nSELECT\n  t.col1 AS a\nFROM data\n", "data.*"),
      ).toThrow("Invalid dbt FROM table name: data.*");
    });

    it("throws when the SELECT body has no column aliases", () => {
      const sql = "\nSELECT\n  1\nFROM data\n";
      expect(() => extractDbtFinalSelectColumnNames(sql, "data")).toThrow(
        "Could not parse dbt SELECT column aliases for FROM data",
      );
    });

    it("throws when FROM table does not match", () => {
      expect(() =>
        extractDbtFinalSelectColumnNames("\nSELECT\n  t.col1 AS a\nFROM other\n", "data"),
      ).toThrow("Could not parse dbt final SELECT for FROM data");
    });
  });
});
