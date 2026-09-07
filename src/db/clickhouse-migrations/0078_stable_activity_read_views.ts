import { buildActivityReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0078_stable_activity_read_views",
    statements: buildActivityReadModelRefreshStatements(),
  };
}
