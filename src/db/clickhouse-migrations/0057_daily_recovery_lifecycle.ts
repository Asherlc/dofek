import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0057_daily_recovery_lifecycle",
    statements: [
      `ALTER TABLE analytics.daily_recovery_inputs
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER rhr_sd_60d`,
      `ALTER TABLE analytics.daily_recovery
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER respiratory_rate_score`,
    ],
  };
}
