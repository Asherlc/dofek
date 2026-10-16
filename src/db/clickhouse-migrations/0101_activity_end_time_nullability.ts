import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const mirrorStatement =
  "ALTER TABLE postgres_fitness.activity MODIFY COLUMN ended_at Nullable(DateTime64(6, 'UTC'))";
const projectionStatement =
  "ALTER TABLE analytics.deduped_activities MODIFY COLUMN ended_at Nullable(DateTime64(6, 'UTC'))";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0101_activity_end_time_nullability",
    phase: "pre-cdc",
    statements: [mirrorStatement, projectionStatement],
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      await runClickHouseMigrationStatement(client, mirrorStatement);
      const result = await client.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'analytics' AND name = 'deduped_activities'",
        format: "JSONEachRow",
      });
      const tables = z.array(z.object({ name: z.string() })).parse(await result.json());
      if (tables.length > 0) await runClickHouseMigrationStatement(client, projectionStatement);
    },
  };
}
