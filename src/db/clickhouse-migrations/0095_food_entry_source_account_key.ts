import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0095_food_entry_source_account_key",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.food_entry ADD COLUMN IF NOT EXISTS source_account_key Nullable(String)",
    ],
  };
}
