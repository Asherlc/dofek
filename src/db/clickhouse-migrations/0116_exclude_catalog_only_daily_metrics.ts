import { buildDailyMetricsReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0116_exclude_catalog_only_daily_metrics",
    statements: buildDailyMetricsReadModelRefreshStatements(),
  };
}
