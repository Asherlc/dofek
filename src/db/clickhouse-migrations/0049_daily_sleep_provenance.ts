import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0049_daily_sleep_provenance",
    statements: [
      `ALTER TABLE analytics.daily_sleep
        ADD COLUMN IF NOT EXISTS source_name Nullable(String) AFTER provider_id`,
      `ALTER TABLE analytics.daily_sleep
        ADD COLUMN IF NOT EXISTS source_providers Array(String) DEFAULT [] AFTER source_name`,
    ],
  };
}
