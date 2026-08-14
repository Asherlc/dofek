import { buildActivityUserSoftDeleteMigrationStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0031_activity_user_soft_delete",
    statements: buildActivityUserSoftDeleteMigrationStatements(),
  };
}
