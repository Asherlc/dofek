import { describe, expect, it } from "vitest";
import { createMigration } from "./0064_activity_summary_freshness.ts";

describe("0064_activity_summary_freshness", () => {
  it("recreates the compatibility view with serving-row freshness", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0064_activity_summary_freshness");
    expect(migration.statements).toEqual([
      "DROP VIEW IF EXISTS analytics.activity_summary",
      expect.stringContaining("climbing_seconds,\n  refreshed_at"),
    ]);
  });
});
