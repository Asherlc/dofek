import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelSql = readFileSync(new URL("./provider_stats.sql", import.meta.url), "utf8");

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("provider_stats model", () => {
  it("counts only active activities", () => {
    expect(modelSql).toContain("source('postgres_fitness', 'activity') }} FINAL");
    expect(modelSql).toContain("provider_absent_at IS null");
    expect(modelSql).toContain("deleted_at IS null");
  });

  it("recounts only dirty providers through reusable provider sets", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("source_provider_refreshes AS");
    expect(modelSql).toContain("current_provider_state AS");
    expect(modelSql).toContain("existing_provider_state AS");
    expect(modelSql).toContain("source_dirty_providers AS");
    expect(modelSql).toContain("stale_providers AS");
    expect(modelSql).toContain("metric_stream_current AS");
    expect(modelSql).toContain("argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted");
    expect(modelSql).toContain("'enable_materialized_cte': 1");
    expect(modelSql).toContain("current_provider_state AS materialized");
    expect(modelSql).toContain("providers AS materialized");
    expect(normalizedSql).toContain(
      "(user_id, provider_id) IN ( SELECT user_id, provider_id FROM providers )",
    );
    expect(modelSql).toContain("'join_use_nulls': 1");
    expect(normalizedSql).not.toContain(
      "FROM {{ source('ingest', 'metric_stream') }} FINAL",
    );
  });
});
