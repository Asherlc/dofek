import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { buildProviderStatsReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0008_complete_provider_stats_raw_mirrors",
    statements: [
      ...buildPostgresFitnessRawTableStatements(),
      ...buildProviderStatsReadModelStatements(),
    ],
  };
}
