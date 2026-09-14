import { buildDailyMetricsReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0091_refresh_daily_metrics_view",
    statements: buildDailyMetricsReadModelRefreshStatements(),
  };
}
