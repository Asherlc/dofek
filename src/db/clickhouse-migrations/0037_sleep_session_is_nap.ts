import type { ClickHouseMigration } from "./types.ts";

const statements = [
  "ALTER TABLE postgres_fitness.sleep_session ADD COLUMN IF NOT EXISTS is_nap Bool DEFAULT false AFTER sleep_type",
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0037_sleep_session_is_nap",
    statements,
  };
}
