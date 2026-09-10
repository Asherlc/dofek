import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { extractClickHouseTableColumnNames } from "../clickhouse-activity-sensor-summary.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../clickhouse-activity-summary.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

interface TableCountRow {
  table_count: number | string;
}

const tableCountRowSchema = z.object({
  table_count: z.union([z.number(), z.string()]),
});

const sensorSummaryTable = "analytics.activity_sensor_summary_rows";
const activitySummaryTable = "analytics.activity_summary_rows";

function buildActivitySensorSummaryRowsTableSqlV0042(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.activity_sensor_summary_rows (
  activity_id UUID,
  user_id UUID,
  avg_hr Nullable(Float64),
  max_hr Nullable(Int16),
  min_hr Nullable(Int16),
  avg_power Nullable(Float64),
  max_power Nullable(Int16),
  avg_speed Nullable(Float64),
  max_speed Nullable(Float64),
  avg_cadence Nullable(Float64),
  elevation_gain_legacy Nullable(Float64),
  avg_left_balance Nullable(Float64),
  avg_left_torque_eff Nullable(Float64),
  avg_right_torque_eff Nullable(Float64),
  avg_left_pedal_smooth Nullable(Float64),
  avg_right_pedal_smooth Nullable(Float64),
  elevation_gain_m Nullable(Float64),
  elevation_loss_m Nullable(Float64),
  avg_stance_time Nullable(Float64),
  avg_vertical_osc Nullable(Float64),
  avg_ground_contact_time Nullable(Float64),
  avg_stride_length Nullable(Float64),
  sample_count Nullable(UInt64),
  hr_sample_count Nullable(UInt64),
  power_sample_count Nullable(UInt64),
  first_sample_at Nullable(DateTime64(6, 'UTC')),
  last_sample_at Nullable(DateTime64(6, 'UTC')),
  best_twenty_minute_power Nullable(Float64),
  normalized_power Nullable(Float64),
  smoothed_avg_power Nullable(Float64),
  climbing_elevation_gain_m Nullable(Float64),
  climbing_seconds Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

async function tableExists(
  client: ClickHouseCommandClient,
  database: string,
  name: string,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const result = await client.query<TableCountRow>({
    query: `SELECT count() AS table_count FROM system.tables WHERE database = '${database}' AND name = '${name}'`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }

  const row = tableCountRowSchema.parse(rows[0]);
  return Number(row.table_count) > 0;
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0042_recreate_activity_sensor_summary_column_order",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      `RENAME TABLE ${sensorSummaryTable} TO ${sensorSummaryTable}_old,
                    ${activitySummaryTable} TO ${activitySummaryTable}_old`,
      buildActivitySensorSummaryRowsTableSqlV0042(),
      buildActivitySummaryRowsTableSql(),
      ...makeCopyStatements(),
      `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
      `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
      buildActivitySummaryViewSql(),
    ],
    run: async (client: ClickHouseCommandClient) => {
      await runClickHouseMigrationStatement(
        client,
        "DROP VIEW IF EXISTS analytics.activity_summary",
      );

      const hasOldSensorSummary = await tableExists(
        client,
        "analytics",
        "activity_sensor_summary_rows_old",
      );
      if (hasOldSensorSummary) {
        await runClickHouseMigrationStatement(client, `DROP TABLE IF EXISTS ${sensorSummaryTable}`);
        await runClickHouseMigrationStatement(
          client,
          `RENAME TABLE ${sensorSummaryTable}_old TO ${sensorSummaryTable}`,
        );
      }

      const hasOldActivitySummary = await tableExists(
        client,
        "analytics",
        "activity_summary_rows_old",
      );
      if (hasOldActivitySummary) {
        await runClickHouseMigrationStatement(
          client,
          `DROP TABLE IF EXISTS ${activitySummaryTable}`,
        );
        await runClickHouseMigrationStatement(
          client,
          `RENAME TABLE ${activitySummaryTable}_old TO ${activitySummaryTable}`,
        );
      }

      const hasSensorSummary = await tableExists(
        client,
        "analytics",
        "activity_sensor_summary_rows",
      );
      const hasActivitySummary = await tableExists(client, "analytics", "activity_summary_rows");

      if (hasSensorSummary || hasActivitySummary) {
        const renames: string[] = [];
        if (hasSensorSummary) {
          renames.push(`${sensorSummaryTable} TO ${sensorSummaryTable}_old`);
        }
        if (hasActivitySummary) {
          renames.push(`${activitySummaryTable} TO ${activitySummaryTable}_old`);
        }
        await runClickHouseMigrationStatement(client, `RENAME TABLE ${renames.join(", ")}`);
      }

      await runClickHouseMigrationStatement(client, buildActivitySensorSummaryRowsTableSqlV0042());
      await runClickHouseMigrationStatement(client, buildActivitySummaryRowsTableSql());

      if (hasSensorSummary) {
        const sensorColumns = extractClickHouseTableColumnNames(
          buildActivitySensorSummaryRowsTableSqlV0042(),
        );
        const cols = sensorColumns.join(", ");
        await runClickHouseMigrationStatement(
          client,
          `INSERT INTO ${sensorSummaryTable} (${cols}) SELECT ${cols} FROM ${sensorSummaryTable}_old`,
        );
        await runClickHouseMigrationStatement(
          client,
          `DROP TABLE IF EXISTS ${sensorSummaryTable}_old`,
        );
      }

      if (hasActivitySummary) {
        const summaryColumns = extractClickHouseTableColumnNames(
          buildActivitySummaryRowsTableSql(),
        );
        const cols = summaryColumns.join(", ");
        await runClickHouseMigrationStatement(
          client,
          `INSERT INTO ${activitySummaryTable} (${cols}) SELECT ${cols} FROM ${activitySummaryTable}_old`,
        );
        await runClickHouseMigrationStatement(
          client,
          `DROP TABLE IF EXISTS ${activitySummaryTable}_old`,
        );
      }

      await runClickHouseMigrationStatement(client, buildActivitySummaryViewSql());
    },
  };
}

function makeCopyStatements(): string[] {
  const sensorColumns = extractClickHouseTableColumnNames(
    buildActivitySensorSummaryRowsTableSqlV0042(),
  );
  const summaryColumns = extractClickHouseTableColumnNames(buildActivitySummaryRowsTableSql());

  const sensorColumnsList = sensorColumns.join(", ");
  const summaryColumnsList = summaryColumns.join(", ");

  return [
    `INSERT INTO ${sensorSummaryTable} (${sensorColumnsList}) SELECT ${sensorColumnsList} FROM ${sensorSummaryTable}_old`,
    `INSERT INTO ${activitySummaryTable} (${summaryColumnsList}) SELECT ${summaryColumnsList} FROM ${activitySummaryTable}_old`,
  ];
}
