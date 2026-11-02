import { buildActivitySummaryViewSql } from "./activity-summary-schema-before-0108.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0064_activity_summary_freshness",
    statements: ["DROP VIEW IF EXISTS analytics.activity_summary", buildActivitySummaryViewSql()],
  };
}
