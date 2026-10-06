import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const statements = [
  `ALTER TABLE analytics.deduped_sensor
    MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild',
      lightweight_mutation_projection_mode = 'rebuild'`,
  `ALTER TABLE analytics.deduped_sensor
    ADD PROJECTION IF NOT EXISTS by_user_channel_day_refresh (
      SELECT user_id, channel, recorded_date, max(refresh_version) AS source_refresh_version
      GROUP BY user_id, channel, recorded_date
    )`,
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0099_activity_sensor_day_versions",
    statements,
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      const result = await client.query({
        query:
          "SELECT name FROM system.tables WHERE database = 'analytics' AND name = 'deduped_sensor'",
        format: "JSONEachRow",
      });
      const tables = z.array(z.object({ name: z.string() })).parse(await result.json());
      if (tables.length === 0) return;
      for (const statement of statements) await runClickHouseMigrationStatement(client, statement);
    },
  };
}
