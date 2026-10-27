import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0100_remove_tracking",
    statements: [
      "DROP VIEW IF EXISTS analytics.provider_change_from_journal_entry",
      "DROP TABLE IF EXISTS postgres_fitness.journal_entry",
      "ALTER TABLE analytics.provider_stats DROP COLUMN IF EXISTS journal_entries",
    ],
  };
}
