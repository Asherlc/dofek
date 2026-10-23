import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0105_activity_absence_provider",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS absence_provider_id Nullable(String)",
    ],
  };
}
