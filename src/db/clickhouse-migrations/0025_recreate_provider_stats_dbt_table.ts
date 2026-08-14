import { buildProviderStatsTableSql } from "../clickhouse-provider-stats.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0025_recreate_provider_stats_dbt_table",
    statements: [
      "DROP TABLE IF EXISTS analytics.provider_stats",
      "DROP VIEW IF EXISTS analytics.provider_stats",
      buildProviderStatsTableSql(),
    ],
  };
}
