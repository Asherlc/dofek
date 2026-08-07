import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0014_resting_heart_rate_sleep_window_materialized_view",
    statements: [],
  };
}
