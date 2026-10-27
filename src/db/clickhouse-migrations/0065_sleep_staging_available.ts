import { buildSleepQualityMigrationStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0065_sleep_staging_available",
    statements: buildSleepQualityMigrationStatements(),
  };
}
