import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0123_ghost_session_scalar_audit",
    statements: [
      "ALTER TABLE analytics.ghost_session_history ADD COLUMN IF NOT EXISTS audit_cursor Nullable(String) AFTER next_cursor",
    ],
  };
}
