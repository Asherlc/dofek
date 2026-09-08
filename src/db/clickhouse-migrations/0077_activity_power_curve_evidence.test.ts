import { describe, expect, it } from "vitest";
import { createMigration } from "./0077_activity_power_curve_evidence.ts";

describe("0077_activity_power_curve_evidence", () => {
  it("adds nullable quality and provenance fields without rewriting history", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0077_activity_power_curve_evidence");
    expect(sql).toContain("ALTER TABLE analytics.activity_power_curve");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS start_offset_seconds Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS observed_samples Nullable(UInt64)");
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS median_sample_interval_seconds Nullable(Float64)",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS largest_gap_seconds Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS coverage_pct Nullable(Float64)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS power_measurement_kind Nullable(String)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_providers Array(String)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_devices Array(String)");
    expect(sql).not.toContain("INSERT INTO");
    expect(sql).not.toContain("UPDATE");
  });
});
