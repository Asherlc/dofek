import { buildActivitySummaryViewSql } from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0064_activity_summary_freshness",
    statements: ["DROP VIEW IF EXISTS analytics.activity_summary", buildActivitySummaryViewSql()],
  };
}
