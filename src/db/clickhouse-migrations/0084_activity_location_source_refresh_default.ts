import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const statement = `ALTER TABLE analytics.activity_location_sample
  MODIFY COLUMN source_refreshed_at DateTime64(9, 'UTC')
  DEFAULT coalesce(refreshed_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC'))`;

const tableCountSchema = z.array(
  z.object({ count: z.union([z.number(), z.string()]).transform(Number) }),
);

export function createMigration(): ClickHouseMigration {
  return {
    id: "0084_activity_location_source_refresh_default",
    statements: [statement],
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      const result = await client.query({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = 'activity_location_sample'",
        format: "JSONEachRow",
      });
      const [row] = tableCountSchema.parse(await result.json());
      if ((row?.count ?? 0) > 0) {
        await runClickHouseMigrationStatement(client, statement);
      }
    },
  };
}
