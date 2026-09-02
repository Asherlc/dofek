import { describe, expect, it } from "vitest";
import { createMigration } from "./0073_activity_sensor_summary_source_version.ts";

describe("0073_activity_sensor_summary_source_version", () => {
  it("adds the source version after the final historical metric column", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0073_activity_sensor_summary_source_version");
    expect(migration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source_refresh_version UInt64 DEFAULT 0 AFTER climbing_seconds"),
      ]),
    );
    expect(migration.statements[0]).not.toContain(" BEFORE ");
    expect(migration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "ALTER TABLE IF EXISTS analytics.activity_sensor_sample ADD PROJECTION IF NOT EXISTS by_activity_source_refresh_version",
        ),
      ]),
    );
  });
});
