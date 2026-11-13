import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0110_remove_daily_scores",
    statements: [
      `ALTER TABLE analytics.daily_recovery
        DROP COLUMN IF EXISTS hrv_score,
        DROP COLUMN IF EXISTS resting_hr_score,
        DROP COLUMN IF EXISTS sleep_score,
        DROP COLUMN IF EXISTS respiratory_rate_score`,
      "ALTER TABLE analytics.daily_strain DROP COLUMN IF EXISTS strain",
    ],
  };
}
