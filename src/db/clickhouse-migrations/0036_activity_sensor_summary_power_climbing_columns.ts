import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

interface TableCountRow {
  table_count: number | string;
}

const tableCountRowSchema = z.object({
  table_count: z.union([z.number(), z.string()]),
});

const statements = [
  "ALTER TABLE analytics.activity_sensor_summary_rows ADD COLUMN IF NOT EXISTS best_twenty_minute_power Nullable(Float64) AFTER last_sample_at",
  "ALTER TABLE analytics.activity_sensor_summary_rows ADD COLUMN IF NOT EXISTS normalized_power Nullable(Float64) AFTER best_twenty_minute_power",
  "ALTER TABLE analytics.activity_sensor_summary_rows ADD COLUMN IF NOT EXISTS smoothed_avg_power Nullable(Float64) AFTER normalized_power",
  "ALTER TABLE analytics.activity_sensor_summary_rows ADD COLUMN IF NOT EXISTS climbing_elevation_gain_m Nullable(Float64) AFTER smoothed_avg_power",
  "ALTER TABLE analytics.activity_sensor_summary_rows ADD COLUMN IF NOT EXISTS climbing_seconds Nullable(Int32) AFTER climbing_elevation_gain_m",
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0036_activity_sensor_summary_power_climbing_columns",
    statements,
    run: async (client) => {
      if (!(await activitySensorSummaryRowsTableExists(client))) {
        return;
      }

      for (const statement of statements) {
        await runClickHouseMigrationStatement(client, statement);
      }
    },
  };
}

async function activitySensorSummaryRowsTableExists(
  client: ClickHouseCommandClient,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const result = await client.query<TableCountRow>({
    query:
      "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'activity_sensor_summary_rows'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }

  const row = tableCountRowSchema.parse(rows[0]);
  return Number(row.table_count) > 0;
}
