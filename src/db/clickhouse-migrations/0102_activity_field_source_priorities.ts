import { buildPostgresFitnessProviderFieldPriorityRawTableStatement } from "../clickhouse-raw-tables.ts";
import { buildActivityReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0102_activity_field_source_priorities",
    phase: "pre-cdc",
    statements: [
      buildPostgresFitnessProviderFieldPriorityRawTableStatement(),
      ...buildActivityReadModelRefreshStatements(),
    ],
  };
}
