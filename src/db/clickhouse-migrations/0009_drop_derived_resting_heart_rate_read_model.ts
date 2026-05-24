import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0009_drop_derived_resting_heart_rate_read_model",
    statements: [
      "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
      "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
    ],
  };
}
