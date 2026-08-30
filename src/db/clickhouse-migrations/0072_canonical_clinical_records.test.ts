import { describe, expect, it, vi } from "vitest";

const rawTableMockState = vi.hoisted(() => ({ omitClinicalRecord: false }));

vi.mock("../clickhouse-raw-tables.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clickhouse-raw-tables.ts")>();

  return {
    ...actual,
    buildPostgresFitnessRawTableStatements: () => {
      const statements = actual.buildPostgresFitnessRawTableStatements();
      return rawTableMockState.omitClinicalRecord
        ? statements.filter((statement) => !statement.includes("postgres_fitness.clinical_record"))
        : statements;
    },
  };
});

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

  it("fails explicitly when the canonical raw clinical table definition is unavailable", () => {
    rawTableMockState.omitClinicalRecord = true;

    expect(() => createMigration()).toThrow(
      "Missing ClickHouse clinical record definition: CREATE TABLE IF NOT EXISTS postgres_fitness.clinical_record (",
    );

    rawTableMockState.omitClinicalRecord = false;
  });
});
