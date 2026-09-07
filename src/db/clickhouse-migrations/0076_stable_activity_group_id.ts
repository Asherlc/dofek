import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const mirrorStatement =
  "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS group_id Nullable(UUID)";
const projectionStatement =
  "ALTER TABLE analytics.activity_source_records ADD COLUMN IF NOT EXISTS group_id Nullable(UUID) AFTER activity_id";
const tableCountSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);

export function createMigration(): ClickHouseMigration {
  return {
    id: "0076_stable_activity_group_id",
    statements: [mirrorStatement, projectionStatement],
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      await runClickHouseMigrationStatement(client, mirrorStatement);
      const result = await client.query({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = 'activity_source_records'",
        format: "JSONEachRow",
      });
      const [row] = tableCountSchema.parse(await result.json());
      if (row.count > 0) await runClickHouseMigrationStatement(client, projectionStatement);
    },
  };
}
