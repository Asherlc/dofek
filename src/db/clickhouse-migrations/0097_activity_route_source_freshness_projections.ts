import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const sensorStatements = [
  `ALTER TABLE analytics.activity_sensor_sample
    MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild',
      lightweight_mutation_projection_mode = 'rebuild'`,
  `ALTER TABLE analytics.activity_sensor_sample
    DROP PROJECTION IF EXISTS by_activity_source_refresh_version`,
  `ALTER TABLE analytics.activity_sensor_sample
    ADD PROJECTION IF NOT EXISTS by_activity_source_refresh_version (
      SELECT activity_id, user_id, max(refresh_version) AS source_refresh_version,
        maxIf(refreshed_at, channel = 'altitude') AS altitude_source_refreshed_at
      GROUP BY activity_id, user_id
    )`,
];
const locationStatements = [
  `ALTER TABLE analytics.activity_location_sample
    MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild',
      lightweight_mutation_projection_mode = 'rebuild'`,
  `ALTER TABLE analytics.activity_location_sample
    ADD PROJECTION IF NOT EXISTS by_activity_location_source_refresh (
      SELECT activity_id, user_id,
        max(greatest(source_refreshed_at, refreshed_at)) AS source_refreshed_at
      GROUP BY activity_id, user_id
    )`,
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0097_activity_route_source_freshness_projections",
    statements: [...sensorStatements, ...locationStatements],
    run: async (client) => {
      if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
      const result = await client.query({
        query: `SELECT name FROM system.tables WHERE database = 'analytics'
          AND name IN ('activity_sensor_sample', 'activity_location_sample')`,
        format: "JSONEachRow",
      });
      const tables = z.array(z.object({ name: z.string() })).parse(await result.json());
      for (const [table, statements] of [
        ["activity_sensor_sample", sensorStatements],
        ["activity_location_sample", locationStatements],
      ] as const) {
        if (tables.some((row) => row.name === table)) {
          for (const statement of statements) {
            await runClickHouseMigrationStatement(client, statement);
          }
        }
      }
    },
  };
}
