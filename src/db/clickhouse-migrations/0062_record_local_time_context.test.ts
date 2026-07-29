import { describe, expect, it } from "vitest";
import { createMigration } from "./0062_record_local_time_context.ts";

describe("0062_record_local_time_context", () => {
  it("adds record-local time context to raw mirrors and serving tables", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0062_record_local_time_context");
    expect(migration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("postgres_fitness.activity"),
        expect.stringContaining("postgres_fitness.sleep_session"),
        expect.stringContaining("analytics.deduped_activities"),
        expect.stringContaining("analytics.daily_sleep"),
      ]),
    );
    expect(migration.statements.join("\n")).toContain("start_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain("end_utc_offset_minutes Nullable(Int16)");
    expect(migration.statements.join("\n")).toContain(
      "local_time_source LowCardinality(String) DEFAULT 'unknown'",
    );
  });
});
