import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0087_complete_peerdb_raw_schema",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.food_entry ADD COLUMN IF NOT EXISTS nutrition_grain Nullable(String)",
      "ALTER TABLE postgres_fitness.health_event ADD COLUMN IF NOT EXISTS source_bundle Nullable(String)",
      "ALTER TABLE postgres_fitness.health_event ADD COLUMN IF NOT EXISTS metadata Nullable(String)",
    ],
  };
}
