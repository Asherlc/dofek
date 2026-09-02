import { describe, expect, it } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import {
  buildActivitySensorSummaryRowsTableSql,
  extractClickHouseTableColumnNames,
} from "../clickhouse-activity-sensor-summary.ts";
import { buildActivitySummaryRowsTableSql } from "../clickhouse-activity-summary.ts";
import { createMigration } from "./0042_recreate_activity_sensor_summary_column_order.ts";

const sensorSummaryTable = "analytics.activity_sensor_summary_rows";
const activitySummaryTable = "analytics.activity_summary_rows";

interface RecordedCommand {
  query: string;
}

function makeQueryClient(
  existingTables: Set<string>,
  clientOptions: { emptyRowsForTableChecks?: boolean } = {},
): ClickHouseCommandClient & {
  commands: RecordedCommand[];
} {
  const commands: RecordedCommand[] = [];
  const tables = new Set([
    ...existingTables,
    "analytics.deduped_sensor",
    "analytics.deduped_location",
    "analytics.v_activity",
  ]);
  return {
    commands,
    command: async (options) => {
      commands.push({ query: options.query });
      if (options.query.startsWith("DROP TABLE IF EXISTS ")) {
        tables.delete(options.query.replace("DROP TABLE IF EXISTS ", ""));
      }
      if (options.query.startsWith("RENAME TABLE ")) {
        const renamePairs = options.query
          .replace("RENAME TABLE ", "")
          .split(",")
          .map((renamePair) => renamePair.trim());
        for (const renamePair of renamePairs) {
          const [source, destination] = renamePair.split(" TO ", 2);
          if (source && destination && tables.has(source)) {
            tables.delete(source);
            tables.add(destination);
          }
        }
      }
    },
    query: async (options) => {
      const databaseMatch = /database = '([^']+)'/.exec(options.query);
      const nameMatch = /name = '([^']+)'/.exec(options.query);
      const tableMatch = /table = '([^']+)'/.exec(options.query);
      const database = databaseMatch?.[1];
      const table = nameMatch?.[1] ?? tableMatch?.[1];
      if (
        clientOptions.emptyRowsForTableChecks &&
        nameMatch &&
        database &&
        table &&
        !tables.has(`${database}.${table}`)
      ) {
        return {
          json: async () => [],
        };
      }
      const tableCount = database && table && tables.has(`${database}.${table}`) ? 1 : 0;
      return {
        json: async () => JSON.parse(JSON.stringify([{ table_count: tableCount }])),
      };
    },
  };
}

function makeCommandOnlyClient(): ClickHouseCommandClient {
  return {
    command: async () => undefined,
  };
}

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

  it("recreates and copies only the sensor summary table when it is the only existing table", async () => {
    const migration = createMigration();
    const client = makeQueryClient(new Set([sensorSummaryTable]));
    const sensorColumns = extractClickHouseTableColumnNames(
      buildActivitySensorSummaryRowsTableSql(),
    ).join(", ");

    await migration.run?.(client, "");

    expect(client.commands.map((command) => command.query)).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `RENAME TABLE ${sensorSummaryTable} TO ${sensorSummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      `INSERT INTO ${sensorSummaryTable} (${sensorColumns}) SELECT ${sensorColumns} FROM ${sensorSummaryTable}_old`,
      `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("recreates and copies only the activity summary table when it is the only existing table", async () => {
    const migration = createMigration();
    const client = makeQueryClient(new Set([activitySummaryTable]));
    const summaryColumns = extractClickHouseTableColumnNames(
      buildActivitySummaryRowsTableSql(),
    ).join(", ");

    await migration.run?.(client, "");

    expect(client.commands.map((command) => command.query)).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `RENAME TABLE ${activitySummaryTable} TO ${activitySummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      `INSERT INTO ${activitySummaryTable} (${summaryColumns}) SELECT ${summaryColumns} FROM ${activitySummaryTable}_old`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("recreates empty tables without rename or copy statements when old tables do not exist", async () => {
    const migration = createMigration();
    const client = makeQueryClient(new Set());

    await migration.run?.(client, "");

    expect(client.commands.map((command) => command.query)).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("treats missing system table rows as absent old tables", async () => {
    const migration = createMigration();
    const client = makeQueryClient(new Set(), { emptyRowsForTableChecks: true });

    await migration.run?.(client, "");

    expect(client.commands.map((command) => command.query)).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("restores old tables before retrying when a previous run failed after rename", async () => {
    const migration = createMigration();
    const client = makeQueryClient(
      new Set([`${sensorSummaryTable}_old`, `${activitySummaryTable}_old`]),
    );
    const sensorColumns = extractClickHouseTableColumnNames(
      buildActivitySensorSummaryRowsTableSql(),
    ).join(", ");
    const summaryColumns = extractClickHouseTableColumnNames(
      buildActivitySummaryRowsTableSql(),
    ).join(", ");

    await migration.run?.(client, "");

    expect(client.commands.map((command) => command.query)).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `DROP TABLE IF EXISTS ${sensorSummaryTable}`,
      `RENAME TABLE ${sensorSummaryTable}_old TO ${sensorSummaryTable}`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}`,
      `RENAME TABLE ${activitySummaryTable}_old TO ${activitySummaryTable}`,
      `RENAME TABLE ${sensorSummaryTable} TO ${sensorSummaryTable}_old, ${activitySummaryTable} TO ${activitySummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSql(),
      buildActivitySummaryRowsTableSql(),
      `INSERT INTO ${sensorSummaryTable} (${sensorColumns}) SELECT ${sensorColumns} FROM ${sensorSummaryTable}_old`,
      `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
      `INSERT INTO ${activitySummaryTable} (${summaryColumns}) SELECT ${summaryColumns} FROM ${activitySummaryTable}_old`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
      expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    ]);
  });

  it("requires a query-capable client because it checks existing ClickHouse tables", async () => {
    const migration = createMigration();

    await expect(migration.run?.(makeCommandOnlyClient(), "")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  describe("canonical column order", () => {
    it("keeps sensor summary power and climbing columns before refresh metadata", () => {
      const columns = extractClickHouseTableColumnNames(buildActivitySensorSummaryRowsTableSql());
      const refreshVersionIndex = columns.indexOf("refresh_version");
      const climbingSecondsIndex = columns.indexOf("climbing_seconds");

      expect(refreshVersionIndex).not.toBe(-1);
      expect(climbingSecondsIndex).not.toBe(-1);
      expect(refreshVersionIndex).toBeGreaterThan(climbingSecondsIndex);
      expect(columns.slice(-3)).toEqual(["refresh_version", "is_deleted", "refreshed_at"]);
    });

    it("keeps activity summary power and climbing columns before refresh metadata", () => {
      const columns = extractClickHouseTableColumnNames(buildActivitySummaryRowsTableSql());
      const refreshVersionIndex = columns.indexOf("refresh_version");
      const climbingSecondsIndex = columns.indexOf("climbing_seconds");

      expect(refreshVersionIndex).not.toBe(-1);
      expect(climbingSecondsIndex).not.toBe(-1);
      expect(refreshVersionIndex).toBeGreaterThan(climbingSecondsIndex);
      expect(columns.slice(-3)).toEqual(["refresh_version", "is_deleted", "refreshed_at"]);
    });
  });
});
