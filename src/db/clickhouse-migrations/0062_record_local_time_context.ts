import type { ClickHouseMigration } from "./types.ts";

const contextColumns = [
  "ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16)",
  "ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16)",
  "ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'",
] as const;

function addContextColumns(table: string, includeTimezone: boolean): string {
  const columns = includeTimezone
    ? ["ADD COLUMN IF NOT EXISTS timezone Nullable(String)", ...contextColumns]
    : contextColumns;
  return `ALTER TABLE ${table}\n  ${columns.join(",\n  ")}`;
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0062_record_local_time_context",
    statements: [
      addContextColumns("postgres_fitness.activity", false),
      addContextColumns("postgres_fitness.sleep_session", true),
      addContextColumns("analytics.activity_source_records", false),
      addContextColumns("analytics.deduped_activities", false),
      addContextColumns("analytics.daily_sleep", true),
    ],
  };
}
