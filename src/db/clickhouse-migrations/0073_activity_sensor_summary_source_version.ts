import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const addSummarySourceVersion = `ALTER TABLE analytics.activity_sensor_summary_rows
ADD COLUMN IF NOT EXISTS source_refresh_version UInt64 DEFAULT 0 AFTER climbing_seconds`;
const enableProjectionRebuild = `ALTER TABLE analytics.activity_sensor_sample
MODIFY SETTING
  deduplicate_merge_projection_mode = 'rebuild',
  lightweight_mutation_projection_mode = 'rebuild'`;
const addSourceVersionProjection = `ALTER TABLE analytics.activity_sensor_sample ADD PROJECTION IF NOT EXISTS by_activity_source_refresh_version (
  SELECT
    activity_id,
    user_id,
    max(refresh_version) AS source_refresh_version
  GROUP BY activity_id, user_id
)`;
const statements = [addSummarySourceVersion, enableProjectionRebuild, addSourceVersionProjection];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0073_activity_sensor_summary_source_version",
    statements,
    run: async (client) => {
      const summaryTableExists = await tableExists(client, "activity_sensor_summary_rows");
      const sampleTableExists = await tableExists(client, "activity_sensor_sample");

      if (summaryTableExists) {
        await runClickHouseMigrationStatement(client, addSummarySourceVersion);
      }
      if (sampleTableExists) {
        await runClickHouseMigrationStatement(client, enableProjectionRebuild);
        await runClickHouseMigrationStatement(client, addSourceVersionProjection);
      }
    },
  };
}

async function tableExists(client: ClickHouseCommandClient, name: string): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const result = await client.query<{ count: number | string }>({
    query:
      "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
    query_params: { name },
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return Number(rows[0]?.count ?? 0) > 0;
}
