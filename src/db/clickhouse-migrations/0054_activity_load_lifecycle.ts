import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0054_activity_load_lifecycle",
    statements: [
      `ALTER TABLE analytics.daily_activity_load
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER daily_load`,
      `ALTER TABLE analytics.daily_strain
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER workload_ratio`,
    ],
  };
}
