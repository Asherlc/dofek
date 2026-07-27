import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("provider_change_watermark.sql");

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("provider_change_watermark model", () => {
  it("materializes incremental provider change watermarks with bounded source scans", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("materialized='incremental'");
    expect(modelSql).toContain("incremental_strategy='append'");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(modelSql).toContain("order_by='(user_id, provider_id)'");
    expect(modelSql).toContain("provider_change_watermark_lookback_hours");
    expect(modelSql).toContain("source('postgres_fitness', 'provider')");
    expect(modelSql).toContain("source('ingest', 'metric_stream')");
    expect(modelSql).toContain("analytics.body_measurement_sample FINAL");
    expect(normalizedSql).toContain("max(changed_at) AS max_changed_at FROM {{ this }}");
    expect(normalizedSql).toContain("INTERVAL {{ provider_change_watermark_lookback_hours }} HOUR");
    expect(modelSql).toContain("existing_provider_watermarks AS");
    expect(modelSql).toContain(
      "OR recent_provider_changes.source_changed_at > existing_provider_watermarks.changed_at",
    );
    expect(modelSql).toContain("'max_threads': 1");
    expect(modelSql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).not.toContain("force_optimize_projection_name");
  });

  it("aggregates metric_stream ingested_at without forcing projections", () => {
    const metricStreamBranch = extractCteSql(modelSql, "source_provider_refreshes")
      .split(/\n\s*UNION ALL\s*\n/)
      .find((branch) => branch.includes("source('ingest', 'metric_stream')"));

    expect(metricStreamBranch).toBeDefined();
    expect(metricStreamBranch).toContain("max(ingested_at)");
    expect(metricStreamBranch).not.toContain("force_optimize_projection_name");
  });
});
