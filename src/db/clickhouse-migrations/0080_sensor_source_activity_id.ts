import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const additions = [
  { table: "sensor_scalar_sample", column: "activity_id Nullable(UUID) AFTER id" },
  {
    table: "deduped_sensor",
    column: "source_activity_id Nullable(UUID) AFTER source_metric_stream_id",
  },
];
const statements = additions.map(
  ({ table, column }) => `ALTER TABLE analytics.${table} ADD COLUMN IF NOT EXISTS ${column}`,
);
const tableSchema = z.array(z.object({ name: z.string() }));

export function createMigration(): ClickHouseMigration {
  return {
    id: "0080_sensor_source_activity_id",
    statements,
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      const result = await client.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'analytics' AND name IN ('sensor_scalar_sample', 'deduped_sensor')",
        format: "JSONEachRow",
      });
      const tables = new Set(tableSchema.parse(await result.json()).map(({ name }) => name));
      for (const { table, column } of additions) {
        if (tables.has(table)) {
          await runClickHouseMigrationStatement(
            client,
            `ALTER TABLE analytics.${table} ADD COLUMN IF NOT EXISTS ${column}`,
          );
        }
      }
    },
  };
}
