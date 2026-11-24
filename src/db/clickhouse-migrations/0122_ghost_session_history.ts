import { createGhostSessionHistorySql } from "../ghost-session-history-schema.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0122_ghost_session_history",
    statements: [createGhostSessionHistorySql],
  };
}
