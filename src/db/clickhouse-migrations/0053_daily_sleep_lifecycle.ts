import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0053_daily_sleep_lifecycle",
    statements: [
      `ALTER TABLE analytics.daily_sleep
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER refresh_version`,
    ],
  };
}
