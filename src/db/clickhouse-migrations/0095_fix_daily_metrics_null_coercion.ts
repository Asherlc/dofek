import { buildDailyMetricsReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0095_fix_daily_metrics_null_coercion",
    statements: buildDailyMetricsReadModelRefreshStatements(),
  };
}
