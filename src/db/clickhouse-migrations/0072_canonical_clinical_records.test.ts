import { describe, expect, it } from "vitest";
import { createMigration } from "./0072_canonical_clinical_records.ts";

describe("0072_canonical_clinical_records", () => {
  it("replaces legacy clinical change views with the canonical source", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0072_canonical_clinical_records");
    expect(migration.statements).toEqual([
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_panel",
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_result",
      expect.stringContaining(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_clinical_record",
      ),
    ]);
    expect(migration.statements[2]).toContain("FROM postgres_fitness.clinical_record");
    expect(migration.statements.join("\n")).not.toContain("FROM postgres_fitness.lab_");
  });
});
