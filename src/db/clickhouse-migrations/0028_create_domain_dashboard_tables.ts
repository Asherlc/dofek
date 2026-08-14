import { createMigration as createDashboardTablesMigration } from "./0026_create_dashboard_tables.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0028_create_domain_dashboard_tables",
    statements: createDashboardTablesMigration().statements,
  };
}
