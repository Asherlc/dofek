import { describe, expect, it } from "vitest";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
  buildIncrementalActivitySummaryStatements,
} from "./clickhouse-activity-summary.ts";

describe("ClickHouse activity summary read model", () => {
  it("creates a dbt-owned incremental target table", () => {
    const sql = buildActivitySummaryRowsTableSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.activity_summary_rows");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(refresh_version)");
    expect(sql).toContain("ORDER BY (user_id, activity_id)");
    expect(sql).not.toContain("CREATE MATERIALIZED VIEW");
    expect(sql).not.toContain("REFRESH EVERY");
  });

  it("keeps analytics.activity_summary as a thin compatibility view", () => {
    const sql = buildActivitySummaryViewSql();

    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_summary");
    expect(sql).toContain("FROM analytics.activity_summary_rows FINAL");
    expect(sql).toContain("WHERE is_deleted = 0");
    expect(sql).toContain("climbing_seconds,\n  refreshed_at");
    expect(sql).not.toContain("JOIN analytics.deduped_sensor");
    expect(sql).not.toContain("FROM ingest.metric_stream");
  });

  it("bootstrap statements expose both the target table and compatibility view", () => {
    const sql = buildIncrementalActivitySummaryStatements().join("\n");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.activity_summary_rows");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_summary");
  });
});
