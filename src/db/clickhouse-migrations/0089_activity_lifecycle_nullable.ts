import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0089_activity_lifecycle_nullable",
    phase: "pre-cdc",
    statements: [
      "ALTER TABLE postgres_fitness.activity MODIFY COLUMN provider_absent_at Nullable(DateTime64(6, 'UTC'))",
      "ALTER TABLE postgres_fitness.activity MODIFY COLUMN deleted_at Nullable(DateTime64(6, 'UTC'))",
    ],
  };
}
