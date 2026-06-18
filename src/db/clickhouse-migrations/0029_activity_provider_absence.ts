import { buildAnalyticsFitnessReadModelStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0029_activity_provider_absence",
    statements: [
      "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS provider_absent_at Nullable(DateTime64(6, 'UTC'))",
      ...buildAnalyticsFitnessReadModelStatements(),
    ],
  };
}
