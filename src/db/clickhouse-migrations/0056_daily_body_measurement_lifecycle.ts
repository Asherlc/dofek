import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const tableCountRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);

export function createMigration(): ClickHouseMigration {
  const statements = [
    `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER body_fat_pct`,
    `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS source_synced_at DateTime64(9, 'UTC')
        DEFAULT toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AFTER is_deleted`,
    `ALTER TABLE analytics.daily_body_measurement
        ADD INDEX IF NOT EXISTS refreshed_at_minmax refreshed_at TYPE minmax GRANULARITY 1`,
    `ALTER TABLE analytics.daily_body_measurement
        MATERIALIZE INDEX refreshed_at_minmax SETTINGS mutations_sync = 2`,
  ];

  return {
    id: "0056_daily_body_measurement_lifecycle",
    statements,
    run: async (client) => {
      if (!client.query) {
        throw new Error("ClickHouse migrations require a query-capable client");
      }
      const result = await client.query<{ count: string }>({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
        format: "JSONEachRow",
        query_params: { name: "daily_body_measurement" },
      });
      const rows = tableCountRowsSchema.parse(await result.json());
      if (rows[0].count === 0) {
        return;
      }
      for (const statement of statements) {
        await runClickHouseMigrationStatement(client, statement);
      }
    },
  };
}
