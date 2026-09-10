import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactWhitespace } from "./read-model-sql-test-helpers.ts";

describe("activity effort identity dbt model contract", () => {
  it("uses canonical source and member projections with a source identity lifecycle key", () => {
    const modelUrl = new URL("../../analytics/models/read_models/activity_effort_identity.sql", import.meta.url);
    expect(existsSync(modelUrl)).toBe(true);
    const sql = readFileSync(modelUrl, "utf8");
    const normalizedSql = compactWhitespace(sql);

    expect(sql).toContain("materialized='incremental'");
    expect(sql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(sql).toContain("ref('activity_source_records')");
    expect(sql).toContain("ref('deduped_activity_members')");
    expect(sql).toContain("source_refreshed_at");
    expect(sql).toContain("stale_identity_rows AS");
    expect(sql).toContain("'pelotonClassId'");
    expect(sql).toContain("'routeId'");
    expect(sql).toContain("'segmentId'");
    expect(sql).toContain("'standardizedTestId'");
    expect(normalizedSql).not.toContain("external_id AS value");
    expect(normalizedSql).not.toContain("source('ingest', 'metric_stream')");
  });
});
