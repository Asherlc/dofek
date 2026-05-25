import { buildClickHouseBootstrapStatements } from "../clickhouse.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(postgresConnectionString: string): ClickHouseMigration {
  return {
    id: "0002_clickhouse_postgres_bridge_and_activity_read_models",
    statements: buildClickHouseBootstrapStatements(postgresConnectionString),
  };
}
