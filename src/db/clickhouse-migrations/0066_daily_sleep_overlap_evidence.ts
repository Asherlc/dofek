import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0066_daily_sleep_overlap_evidence",
    statements: [
      `ALTER TABLE analytics.daily_sleep
        ADD COLUMN IF NOT EXISTS selected_session_id Nullable(UUID) DEFAULT NULL
        AFTER source_providers`,
      `ALTER TABLE analytics.daily_sleep
        ADD COLUMN IF NOT EXISTS overlapping_sessions Array(Tuple(
          session_id UUID,
          provider_id String,
          source_name Nullable(String),
          source_providers Array(String),
          timezone Nullable(String),
          start_utc_offset_minutes Nullable(Int16),
          end_utc_offset_minutes Nullable(Int16),
          local_time_source String,
          started_at DateTime64(6, 'UTC'),
          ended_at Nullable(DateTime64(6, 'UTC')),
          duration_minutes Nullable(Int32)
        )) DEFAULT []
        AFTER selected_session_id`,
    ],
  };
}
