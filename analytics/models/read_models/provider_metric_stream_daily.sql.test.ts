import { describe, expect, it } from "vitest";
import { compactWhitespace, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const modelSql = readModelSql("provider_metric_stream_daily.sql");

describe("provider_metric_stream_daily model", () => {
  it("uses bounded incremental day changes and an exact latest-state count", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("materialized='incremental'");
    expect(modelSql).toContain("incremental_strategy='append'");
    expect(modelSql).toContain("full_refresh=false");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(modelSql).toContain("order_by='(user_id, provider_id, recorded_date)'");
    expect(modelSql).toContain("'max_threads': 1");
    expect(modelSql).toContain(
      "'preferred_optimize_projection_name': 'by_provider_current_state_recorded_at'",
    );
    expect(modelSql).toContain("provider_metric_stream_day_batch_size");
    expect(modelSql).toContain("source('analytics', 'metric_stream_day_change')");
    expect(modelSql).toContain("source('ingest', 'metric_stream_current')");
    expect(modelSql).toContain("existing_daily_state AS");
    expect(modelSql).toContain("dirty_days AS MATERIALIZED");
    expect(normalizedSql).toContain("LIMIT {{ provider_metric_stream_day_batch_size }}");
    expect(normalizedSql).toContain(
      "argMax( tuple(recorded_at, ingested_at, version, is_deleted), tuple(version, ingested_at) )",
    );
    expect(modelSql).toContain("countIf(metric_stream_current.is_deleted = 0)");
    expect(modelSql).toContain("source_changed_at");
    expect(modelSql).toContain("coalesce(metric_stream_counts.metric_stream_count, 0)");
  });
});
