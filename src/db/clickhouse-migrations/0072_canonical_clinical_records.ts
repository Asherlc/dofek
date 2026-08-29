import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0072_canonical_clinical_records",
    statements: [
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_panel",
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_result",
      `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_clinical_record
TO analytics.provider_change_state
AS
SELECT
  user_id,
  provider_id,
  max(now64(9)) AS changed_at
FROM postgres_fitness.clinical_record
GROUP BY user_id, provider_id`,
    ],
  };
}
