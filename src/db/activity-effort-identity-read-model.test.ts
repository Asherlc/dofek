import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactWhitespace } from "./read-model-sql-test-helpers.ts";

describe("activity effort identity dbt model contract", () => {
  it("uses canonical source and member projections with a source identity lifecycle key", () => {
    const modelUrl = new URL(
      "../../analytics/models/read_models/activity_effort_identity.sql",
      import.meta.url,
    );
    expect(existsSync(modelUrl)).toBe(true);
    const sql = readFileSync(modelUrl, "utf8");
    const normalizedSql = compactWhitespace(sql);

    expect(normalizedSql).toContain("materialized='incremental'");
    expect(normalizedSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(normalizedSql).toContain("'enable_materialized_cte': 1");
    expect(normalizedSql).toContain("current_source_members AS MATERIALIZED");
    expect(normalizedSql).toContain("changed_source_keys AS MATERIALIZED");
    expect(normalizedSql).toContain("ref('activity_source_records')");
    expect(normalizedSql).toContain("ref('deduped_activity_members')");
    expect(normalizedSql).toContain("source_refreshed_at");
    expect(normalizedSql).toContain("stale_identity_rows AS");
    expect(normalizedSql).toContain("'pelotonClassId'");
    expect(normalizedSql).toContain("'routeId'");
    expect(normalizedSql).toContain("'segmentId'");
    expect(normalizedSql).toContain("'standardizedTestId'");
    expect(normalizedSql).not.toContain("external_id AS value");
    expect(normalizedSql).not.toContain("source('ingest', 'metric_stream')");
  });
});
