import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0112_remove_healthspan",
    statements: [
      "DROP TABLE IF EXISTS analytics.weekly_healthspan SYNC",
      "DROP TABLE IF EXISTS analytics.healthspan_activity_zone_minutes SYNC",
    ],
  };
}
