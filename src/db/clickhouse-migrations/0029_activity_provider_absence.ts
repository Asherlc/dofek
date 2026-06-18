import { buildProviderActivityAbsenceMigrationStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0029_activity_provider_absence",
    statements: buildProviderActivityAbsenceMigrationStatements(),
  };
}
