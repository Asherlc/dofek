import { describe, expect, it } from "vitest";
import { lintMigrationPolicyFile } from "./migration-policy.ts";

describe("migration policy", () => {
  it("allows schema-only migration statements", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_add_activity_note.sql",
      `
ALTER TABLE fitness.activity ADD COLUMN IF NOT EXISTS note text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS activity_note_idx ON fitness.activity (note);
DROP VIEW IF EXISTS analytics.old_activity_view;
CREATE VIEW analytics.activity_note_summary AS SELECT id, note FROM fitness.activity;
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

  it("blocks ClickHouse refresh and mutation statements in deploy migrations", () => {
    const violations = lintMigrationPolicyFile(
      "drizzle/0027_bad_clickhouse.sql",
      `
SYSTEM REFRESH VIEW analytics.activity_summary;
SYSTEM WAIT VIEW analytics.activity_summary;
CREATE MATERIALIZED VIEW analytics.body_measurement REFRESH EVERY 1 HOUR AS SELECT 1;
ALTER TABLE analytics.deduped_sensor UPDATE scalar = 0 WHERE channel = 'steps';
OPTIMIZE TABLE analytics.deduped_sensor FINAL;
`,
    );

    expect(violations.map((violation) => violation.ruleName)).toEqual([
      "system-refresh-view",
      "system-wait-view",
      "refresh-every",
      "clickhouse-alter-table-update",
      "optimize-final",
    ]);
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
});
