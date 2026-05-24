import { buildActivitySummaryReadModelStatements } from "../clickhouse-metric-stream-bootstrap.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0015_activity_summary_centroids",
    statements: [
      "DROP VIEW IF EXISTS analytics.activity_summary_before_centroids",
      "DROP TABLE IF EXISTS analytics.activity_summary_before_centroids",
      "DROP VIEW IF EXISTS analytics.activity_summary_centroids_next",
      "DROP TABLE IF EXISTS analytics.activity_summary_centroids_next",
      ...buildActivitySummaryReadModelStatements("analytics.activity_summary_centroids_next"),
      "RENAME TABLE analytics.activity_summary TO analytics.activity_summary_before_centroids, analytics.activity_summary_centroids_next TO analytics.activity_summary",
      "DROP VIEW IF EXISTS analytics.activity_summary_before_centroids",
      "DROP TABLE IF EXISTS analytics.activity_summary_before_centroids",
    ],
  };
}
