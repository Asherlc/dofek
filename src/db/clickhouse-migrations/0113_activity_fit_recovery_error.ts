import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0113_activity_fit_recovery_error",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS fit_recovery_error Nullable(String) AFTER raw",
    ],
  };
}
