import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintMigrationPolicyFile } from "./migration-policy.ts";

describe("migration policy", () => {
  it("allows schema-only migration statements", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_add_activity_note.sql",
      `
ALTER TABLE fitness.activity ADD COLUMN IF NOT EXISTS note text;
CREATE INDEX IF NOT EXISTS activity_note_idx ON fitness.activity (note);
DROP VIEW IF EXISTS analytics.old_activity_view;
CREATE VIEW analytics.activity_note_summary AS SELECT id, note FROM fitness.activity;
`,
    );

    expect(violations).toEqual([]);
  });

  it("blocks concurrent index DDL in transaction-bound Drizzle migrations", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_concurrent_indexes.sql",
      `
CREATE INDEX CONCURRENTLY activity_note_idx ON fitness.activity (note);
DROP INDEX CONCURRENTLY fitness.activity_note_idx;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0061_concurrent_indexes.sql",
        lineNumber: 2,
        ruleName: "drizzle-concurrent-index",
      }),
      expect.objectContaining({
        filePath: "drizzle/0061_concurrent_indexes.sql",
        lineNumber: 3,
        ruleName: "drizzle-concurrent-index",
      }),
    ]);
  });

  it("does not apply the Drizzle transaction rule outside Postgres migrations", () => {
    const violations = lintMigrationPolicyFile(
      "maintenance/rebuild-index.sql",
      "CREATE INDEX CONCURRENTLY activity_note_idx ON fitness.activity (note);",
    );

    expect(violations).toEqual([]);
  });

  it("allows Postgres foreign keys with ON DELETE clauses", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0044_tighten_fk_delete_rules.sql",
      `
ALTER TABLE fitness.lab_result
DROP CONSTRAINT IF EXISTS lab_result_panel_id_fkey,
ADD CONSTRAINT lab_result_panel_id_fkey
FOREIGN KEY (panel_id) REFERENCES fitness.lab_panel (id)
ON DELETE CASCADE ON UPDATE NO ACTION;
`,
    );

    expect(violations).toEqual([]);
  });

  it("ignores blocked phrases inside SQL comments", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_document_backfill.sql",
      `
-- Backfill job will run INSERT INTO fitness.metric_stream SELECT separately.
/*
SYSTEM REFRESH VIEW analytics.activity_summary
*/
ALTER TABLE fitness.metric_stream ADD COLUMN IF NOT EXISTS external_id text;
`,
    );

    expect(violations).toEqual([]);
  });

  it("blocks inline historical backfills in deploy migrations", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_bad_backfill.sql",
      `
INSERT INTO fitness.metric_stream (recorded_at, user_id)
SELECT recorded_at, user_id
FROM fitness.body_measurement;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0027_bad_backfill.sql",
        lineNumber: 2,
        ruleName: "insert-select",
      }),
    ]);
  });

  it("allows an atomic normalization copy that removes the source storage", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_normalize_supplements.sql",
      `
CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY,
  supplement_id uuid NOT NULL,
  amount real
);
ALTER TABLE fitness.supplement RENAME TO supplement_legacy;
INSERT INTO fitness.supplement_definition (id, supplement_id, amount)
SELECT id, id, amount
FROM fitness.supplement_legacy;
DROP TABLE fitness.supplement_legacy;

CREATE TABLE fitness.supplement_definition_nutrient (
  definition_id uuid NOT NULL,
  nutrient_id text NOT NULL
);
ALTER TABLE fitness.supplement_nutrient RENAME TO supplement_nutrient_legacy;
INSERT INTO fitness.supplement_definition_nutrient (definition_id, nutrient_id)
SELECT supplement_id, nutrient_id
FROM fitness.supplement_nutrient_legacy;
DROP TABLE fitness.supplement_nutrient_legacy;
`,
    );

    expect(violations).toEqual([]);
  });

  it("blocks partial-column copies that retain the source relation", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_partial_normalization.sql",
      `
CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY,
  amount real
);
INSERT INTO fitness.supplement_definition (id, amount)
SELECT id, amount
FROM fitness.supplement;
ALTER TABLE fitness.supplement DROP COLUMN amount;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0061_partial_normalization.sql",
        ruleName: "insert-select",
      }),
    ]);
  });

  it("blocks normalization copies that retain the source storage", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_dual_write.sql",
      `
CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY,
  amount real
);
INSERT INTO fitness.supplement_definition (id, amount)
SELECT id, amount
FROM fitness.supplement;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0061_dual_write.sql",
        lineNumber: 6,
        ruleName: "insert-select",
      }),
    ]);
  });

  it("blocks normalization copies joined to any retained relation", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_joined_copy.sql",
      `
CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY,
  nutrient_id text
);
INSERT INTO fitness.supplement_definition (id, nutrient_id)
SELECT legacy.id, nutrient.id
FROM fitness.supplement_legacy AS legacy
INNER JOIN fitness.nutrient AS nutrient ON nutrient.id = 'magnesium';
DROP TABLE fitness.supplement_legacy;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0061_joined_copy.sql",
        ruleName: "insert-select",
      }),
    ]);
  });

  it("blocks comma-join normalization copies", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0061_comma_join.sql",
      `
CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY,
  nutrient_id text
);
INSERT INTO fitness.supplement_definition (id, nutrient_id)
SELECT legacy.id, nutrient.id
FROM fitness.supplement_legacy AS legacy, fitness.nutrient AS nutrient;
DROP TABLE fitness.supplement_legacy;
DROP TABLE fitness.nutrient;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "drizzle/0061_comma_join.sql",
        ruleName: "insert-select",
      }),
    ]);
  });

  it("blocks ClickHouse refresh and mutation statements in deploy migrations", () => {
    const violations = lintMigrationPolicyFile(
      "src/db/clickhouse-sql/bad_mutation.sql",
      `
SYSTEM REFRESH VIEW analytics.activity_summary;
SYSTEM WAIT VIEW analytics.activity_summary;
CREATE MATERIALIZED VIEW analytics.body_measurement REFRESH EVERY 1 HOUR AS SELECT 1;
ALTER TABLE analytics.deduped_sensor UPDATE scalar = 0 WHERE channel = 'steps';
OPTIMIZE TABLE analytics.deduped_sensor FINAL;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad_mutation.sql",
        lineNumber: 2,
        ruleName: "system-refresh-view",
      }),
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad_mutation.sql",
        lineNumber: 3,
        ruleName: "system-wait-view",
      }),
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad_mutation.sql",
        lineNumber: 4,
        ruleName: "refresh-every",
      }),
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad_mutation.sql",
        lineNumber: 5,
        ruleName: "clickhouse-alter-table-update",
      }),
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad_mutation.sql",
        lineNumber: 6,
        ruleName: "optimize-final",
      }),
    ]);
  });

  it("blocks naive ClickHouse materialized read models", () => {
    const violations = lintMigrationPolicyFile(
      "src/db/clickhouse-sql/bad-read-model.sql",
      `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window
AS SELECT * FROM analytics.deduped_sensor;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad-read-model.sql",
        lineNumber: 2,
        ruleName: "clickhouse-naive-materialized-view",
      }),
    ]);
  });

  it("blocks dbt analytics models that are not explicit incremental models", () => {
    const violations = lintMigrationPolicyFile(
      "analytics/models/read_models/bad_model.sql",
      `
{{ config(materialized='view') }}

SELECT 1 AS value
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "analytics/models/read_models/bad_model.sql",
        lineNumber: 1,
        ruleName: "analytics-dbt-incremental-model",
      }),
    ]);
  });

  it("allows explicit incremental dbt analytics models", () => {
    const violations = lintMigrationPolicyFile(
      "analytics/models/read_models/good_model.sql",
      `
{{ config(
    materialized='incremental',
    incremental_strategy='append'
) }}

SELECT 1 AS value
`,
    );

    expect(violations).toEqual([]);
  });

  it("does not treat TO inside a query literal as a materialized view target", () => {
    const violations = lintMigrationPolicyFile(
      "src/db/clickhouse-sql/bad-read-model.sql",
      `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window
AS SELECT 'TO' AS token FROM analytics.deduped_sensor;
`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        filePath: "src/db/clickhouse-sql/bad-read-model.sql",
        lineNumber: 2,
        ruleName: "clickhouse-naive-materialized-view",
      }),
    ]);
  });

  it("allows ClickHouse insert-triggered materialized views that target incremental tables", () => {
    const violations = lintMigrationPolicyFile(
      "src/db/clickhouse-sql/incremental-ingest.sql",
      `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_dirty_key_ingest
TO analytics.resting_heart_rate_dirty_key
AS SELECT id FROM postgres_fitness.sleep_session;
`,
    );

    expect(violations).toEqual([]);
  });

  it("allows ClickHouse insert-triggered materialized views with quoted target identifiers", () => {
    const violations = lintMigrationPolicyFile(
      "src/db/clickhouse-sql/incremental-ingest.sql",
      `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_dirty_key_ingest
TO "analytics"."resting_heart_rate_dirty_key"
AS SELECT id FROM postgres_fitness.sleep_session;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor_dirty_key_ingest
TO \`analytics\`.\`deduped_sensor_dirty_key\`
AS SELECT id FROM postgres_fitness.metric_stream;
`,
    );

    expect(violations).toEqual([]);
  });

  it("blocks unbounded update and delete statements", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_bad_dml.sql",
      `
UPDATE fitness.provider SET enabled = true;
DELETE FROM fitness.provider_token;
UPDATE fitness.user_profile SET timezone = 'UTC' WHERE timezone IS NULL;
`,
    );

    expect(violations.map((violation) => violation.ruleName)).toEqual([
      "unbounded-update",
      "unbounded-delete",
    ]);
  });

  it("does not split statements on semicolons inside SQL literals", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_literal_semicolon.sql",
      `
UPDATE fitness.provider SET name = 'safe;still safe' WHERE id = 'provider-1';
UPDATE fitness.provider SET name = $$safe;still safe$$ WHERE id = 'provider-2';
UPDATE fitness.provider SET "display;name" = 'safe' WHERE id = 'provider-3';
`,
    );

    expect(violations).toEqual([]);
  });

  it("allows and constrains the climbing entry migration", () => {
    const migrationPath = "drizzle/0047_climbing_entry.sql";
    const migrationSql = readFileSync(migrationPath, "utf8");

    expect(lintMigrationPolicyFile(migrationPath, migrationSql)).toEqual([]);
    expect(migrationSql).toMatch(
      /CREATE TYPE fitness\.climbing_climb_type AS ENUM \('boulder', 'route'\)/,
    );
    expect(migrationSql).toMatch(
      /CREATE TYPE fitness\.climbing_grade_system AS ENUM \('v_scale', 'yds'\)/,
    );
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS fitness.climbing_entry");
    expect(migrationSql).toContain("id uuid PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(migrationSql).toMatch(
      /activity_id uuid NOT NULL REFERENCES fitness\.activity\s*\(id\) ON DELETE CASCADE/,
    );
    expect(migrationSql).toContain("external_id text");
    expect(migrationSql).toContain("climb_type fitness.climbing_climb_type NOT NULL");
    expect(migrationSql).toContain("grade_system fitness.climbing_grade_system NOT NULL");
    expect(migrationSql).toContain("grade text NOT NULL");
    expect(migrationSql).toContain("sent boolean NOT NULL");
    expect(migrationSql).toContain("route_name text");
    expect(migrationSql).toContain("location_name text");
    expect(migrationSql).toContain("source_name text");
    expect(migrationSql).toContain("raw jsonb");
    expect(migrationSql).toContain("created_at timestamptz NOT NULL DEFAULT now()");
    expect(migrationSql).toContain(
      "CONSTRAINT climbing_entry_grade_nonempty CHECK (btrim(grade) <> '')",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT climbing_entry_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> '')",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT climbing_entry_route_name_nonempty CHECK (route_name IS NULL OR btrim(route_name) <> '')",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT climbing_entry_location_name_nonempty CHECK (location_name IS NULL OR btrim(location_name) <> '')",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT climbing_entry_source_name_nonempty CHECK (source_name IS NULL OR btrim(source_name) <> '')",
    );
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS climbing_entry_activity_external_id_idx\s+ON fitness\.climbing_entry \(activity_id, external_id\)\s+WHERE external_id IS NOT NULL/,
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX IF NOT EXISTS climbing_entry_activity_idx(?: -- noqa: PG01)?\s+ON fitness\.climbing_entry \(activity_id\)/,
    );
    expect(migrationSql).toMatch(
      /CREATE INDEX IF NOT EXISTS climbing_entry_grade_lookup_idx(?: -- noqa: PG01)?\s+ON fitness\.climbing_entry \(climb_type, grade_system, grade\)/,
    );
    expect(migrationSql).not.toMatch(/NOT NULL DEFAULT ''/);
  });
});
