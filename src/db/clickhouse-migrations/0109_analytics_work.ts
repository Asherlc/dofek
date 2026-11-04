import { analyticsWorkSchemaStatements } from "../analytics-work-schema.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0109_analytics_work",
    phase: "pre-cdc",
    statements: analyticsWorkSchemaStatements(),
  };
}
