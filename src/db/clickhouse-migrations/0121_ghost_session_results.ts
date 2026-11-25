import { createGhostSessionPageSql } from "../ghost-session-result-schema.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0121_ghost_session_results",
    statements: [createGhostSessionPageSql],
  };
}
