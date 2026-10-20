import { buildActivityReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0103_strong_strength_title_precedence",
    phase: "pre-cdc",
    statements: buildActivityReadModelRefreshStatements(),
  };
}
