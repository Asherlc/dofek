import { describe, expect, it } from "vitest";
import { createMigration } from "./0062_record_local_time_context.ts";

describe("0062_record_local_time_context", () => {
  it("adds record-local time context to raw mirrors and serving tables", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0062_record_local_time_context");
    expect(migration.statements).toEqual([
      `ALTER TABLE postgres_fitness.activity
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE postgres_fitness.sleep_session
  ADD COLUMN IF NOT EXISTS timezone Nullable(String),
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.activity_source_records
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.deduped_activities
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
      `ALTER TABLE analytics.daily_sleep
  ADD COLUMN IF NOT EXISTS timezone Nullable(String),
  ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16),
  ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'`,
    ]);
    expect(migration.statements.join("\n")).toContain("start_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain("end_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain(
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    );
  });
});
