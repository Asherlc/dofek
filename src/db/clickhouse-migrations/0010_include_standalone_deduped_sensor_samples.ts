import { buildClickHouseBootstrapStatements } from "../clickhouse.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(postgresConnectionString: string): ClickHouseMigration {
  return {
    id: "0010_include_standalone_deduped_sensor_samples",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.deduped_sensor",
      ...buildClickHouseBootstrapStatements(postgresConnectionString),
    ],
  };
}
