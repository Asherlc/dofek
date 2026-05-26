import { buildIncrementalActivitySummaryStatements } from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0022_incremental_activity_summary",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary",
      "DROP TABLE IF EXISTS analytics.activity_summary_rows",
      ...buildIncrementalActivitySummaryStatements(),
    ],
  };
}
