import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactWhitespace } from "./read-model-sql-test-helpers.ts";

const modelSql = readFileSync(new URL("./provider_stats.sql", import.meta.url), "utf8");

describe("provider_stats model", () => {
  it("counts only active activities", () => {
    expect(modelSql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(modelSql).toContain("provider_absent_at IS null");
    expect(modelSql).toContain("deleted_at IS null");
  });

  it("recounts only dirty providers through reusable provider sets", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("ref('provider_change_watermark')");
    expect(modelSql).toContain("full_refresh=false");
    expect(modelSql).not.toContain("source_provider_refreshes AS");
    expect(modelSql).toContain("current_provider_state AS");
    expect(modelSql).toContain("existing_provider_state AS");
    expect(modelSql).toContain("source_dirty_providers AS");
    expect(modelSql).not.toContain("stale_providers AS");
    expect(modelSql).toContain("ref('provider_metric_stream_daily')");
    expect(modelSql).toContain("source('analytics', 'metric_stream_day_change')");
    expect(modelSql).toContain("metric_stream_daily_dirty_providers AS");
    expect(modelSql).toContain("metric_stream_counts AS");
    expect(modelSql).toContain("sum(metric_stream_count) AS count");
    expect(modelSql).toContain("ref('provider_metric_stream_daily') }} FINAL");
    expect(modelSql).toContain("'enable_materialized_cte': 1");
    expect(modelSql).toContain("'optimize_aggregation_in_order': 1");
    expect(modelSql).not.toContain("current_provider_state AS materialized");
    expect(modelSql).toContain("source_dirty_providers AS materialized");
    expect(modelSql).not.toContain("metric_stream_daily_source_state AS materialized");
    expect(modelSql).not.toContain("metric_stream_daily_target_state AS materialized");
    expect(modelSql).not.toContain("metric_stream_daily_dirty_providers AS materialized");
    expect(modelSql).toContain("providers AS materialized");
    expect(modelSql).toContain("provider_dirty_key_batch_size");
    expect(normalizedSql).toContain("LIMIT {{ provider_dirty_key_batch_size }}");
    expect(normalizedSql).toContain("existing_provider_state.refreshed_at");
    expect(normalizedSql).toContain("candidate_dirty_providers.source_changed_at ASC");
    expect(normalizedSql).toContain(
      "(user_id, provider_id) IN ( SELECT user_id, provider_id FROM providers )",
    );
    expect(normalizedSql).toContain(
      "(user_id, provider_id) IN ( SELECT user_id, provider_id FROM source_dirty_providers )",
    );
    expect(modelSql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).not.toContain("source('ingest', 'metric_stream')");
  });
});
