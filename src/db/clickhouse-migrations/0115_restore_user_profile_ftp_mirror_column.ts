import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0115_restore_user_profile_ftp_mirror_column",
    statements: [
      "ALTER TABLE postgres_fitness.user_profile ADD COLUMN IF NOT EXISTS ftp Nullable(Int16) AFTER resting_hr",
    ],
  };
}
