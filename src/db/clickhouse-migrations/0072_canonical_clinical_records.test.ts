import { describe, expect, it } from "vitest";
import { createMigration } from "./0072_canonical_clinical_records.ts";

describe("0072_canonical_clinical_records", () => {
  it("upgrades provider stats, repopulates provider keys, and replaces change views", () => {
    const migration = createMigration();
    const sql = migration.statements.join("\n");

    expect(migration.id).toBe("0072_canonical_clinical_records");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.provider_stats");
    expect(sql).toContain(
      "ALTER TABLE analytics.provider_stats ADD COLUMN IF NOT EXISTS clinical_records UInt64 AFTER nutrition_daily",
    );
    expect(sql).toContain("ALTER TABLE analytics.provider_stats DROP COLUMN IF EXISTS lab_panels");
    expect(sql).toContain("ALTER TABLE analytics.provider_stats DROP COLUMN IF EXISTS lab_results");
    expect(sql).toContain("INSERT INTO analytics.provider_change_state");
    expect(sql).toContain("FROM analytics.provider_stats FINAL");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.clinical_record");
    expect(sql).toContain("FROM postgres_fitness.clinical_record FINAL");
    expect(sql).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_clinical_record",
    );
    expect(sql).not.toContain("FROM postgres_fitness.lab_");
  });
});
