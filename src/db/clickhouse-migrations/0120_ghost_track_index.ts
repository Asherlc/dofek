import { createGhostTrackIndexSql } from "../ghost-track-index-schema.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0120_ghost_track_index",
    statements: [createGhostTrackIndexSql],
  };
}
