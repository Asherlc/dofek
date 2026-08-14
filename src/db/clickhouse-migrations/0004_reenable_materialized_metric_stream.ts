import { buildClickHouseBootstrapStatements } from "../clickhouse.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(postgresConnectionString: string): ClickHouseMigration {
  return {
    id: "0004_reenable_materialized_metric_stream",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.deduped_sensor",
      "DROP DATABASE IF EXISTS postgres_fitness SYNC",
      ...buildClickHouseBootstrapStatements(postgresConnectionString),
    ],
  };
}
