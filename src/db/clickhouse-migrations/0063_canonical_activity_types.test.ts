import { describe, expect, it } from "vitest";
import { createMigration } from "./0063_canonical_activity_types.ts";

describe("0063_canonical_activity_types", () => {
  it("migrates the replicated activity source before rebuilding serving models", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0063_canonical_activity_types");
    expect(migration.statements).toContain(
      "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS provider_type String DEFAULT canonical_type AFTER canonical_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ADD COLUMN IF NOT EXISTS modality Nullable(String) AFTER provider_type",
    );
    expect(migration.statements.join("\n")).toContain(
      "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
    );
  });

  it("normalizes every historical qualifier and preserves the former provider type", () => {
    const sql = createMigration().statements.join("\n");

    expect(sql).toContain("MATERIALIZE COLUMN provider_type");
    expect(sql).toContain("WHEN 'road_cycling' THEN 'road'");
    expect(sql).toContain("WHEN 'road_cycling' THEN 'cycling'");
    expect(sql).toContain("WHEN 'football' THEN 'american_football'");
    expect(sql).toContain("WHEN 'rock_climbing' THEN 'climbing'");
    expect(sql).toContain("ELSE canonical_type");
    expect(sql).toContain("modality = if(modality IS NULL");
    expect(sql).toContain("throwIf(countIf(canonical_type = '') > 0");
  });
});
