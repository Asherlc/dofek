import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0075_activity_rejected_local_time_context",
    statements: [
      `ALTER TABLE postgres_fitness.activity
        ADD COLUMN IF NOT EXISTS rejected_provider_timezone Nullable(String) AFTER local_time_source,
        ADD COLUMN IF NOT EXISTS rejected_provider_start_utc_offset_minutes Nullable(Int64) AFTER rejected_provider_timezone,
        ADD COLUMN IF NOT EXISTS rejected_provider_end_utc_offset_minutes Nullable(Int64) AFTER rejected_provider_start_utc_offset_minutes`,
    ],
  };
}
