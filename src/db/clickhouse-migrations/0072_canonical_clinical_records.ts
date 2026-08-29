import { buildProviderStatsTableSql } from "../clickhouse-provider-stats.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0072_canonical_clinical_records",
    statements: [
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_panel",
      "DROP VIEW IF EXISTS analytics.provider_change_from_lab_result",
      buildProviderStatsTableSql(),
      "ALTER TABLE analytics.provider_stats ADD COLUMN IF NOT EXISTS clinical_records UInt64 AFTER nutrition_daily",
      "ALTER TABLE analytics.provider_stats DROP COLUMN IF EXISTS lab_panels",
      "ALTER TABLE analytics.provider_stats DROP COLUMN IF EXISTS lab_results",
      `INSERT INTO analytics.provider_change_state (user_id, provider_id, changed_at)
SELECT
  user_id,
  provider_id,
  max(now64(9)) AS changed_at
FROM analytics.provider_stats FINAL
GROUP BY user_id, provider_id`,
      `INSERT INTO analytics.provider_change_state (user_id, provider_id, changed_at)
SELECT
  user_id,
  provider_id,
  max(now64(9)) AS changed_at
FROM postgres_fitness.clinical_record FINAL
WHERE _peerdb_is_deleted = 0
GROUP BY user_id, provider_id`,
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
