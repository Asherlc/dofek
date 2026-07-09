import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const streamPointsStatements = [
  "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
  "ALTER TABLE analytics.activity_stream_points ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
];

const heartRateZoneStatements = [
  "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS is_deleted UInt8 AFTER refresh_version",
  "ALTER TABLE analytics.activity_heart_rate_zones ADD COLUMN IF NOT EXISTS refreshed_at DateTime64(9, 'UTC') AFTER is_deleted",
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0043_activity_stream_lifecycle_columns",
    statements: [...streamPointsStatements, ...heartRateZoneStatements],
    run: async (client) => {
      if (await tableExists(client, "activity_stream_points")) {
        for (const statement of streamPointsStatements) {
          await runClickHouseMigrationStatement(client, statement);
        }
      }
      if (await tableExists(client, "activity_heart_rate_zones")) {
        for (const statement of heartRateZoneStatements) {
          await runClickHouseMigrationStatement(client, statement);
        }
      }
    },
  };
}

async function tableExists(client: ClickHouseCommandClient, name: string): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const result = await client.query<{ count: string | number }>({
    query: `SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = '${name}'`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return rows.length > 0 && Number(rows[0]?.count ?? 0) > 0;
}
