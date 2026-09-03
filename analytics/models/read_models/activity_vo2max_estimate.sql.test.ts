import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_vo2max_estimate.sql");

describe("activity_vo2max_estimate model", () => {
  it("includes canonical running in the upstream activity filter", () => {
    const currentActivitySql = extractCteSql(modelSql, "current_activity");

    expect(currentActivitySql).toMatch(/canonical_type IN \([\s\S]*'running'[\s\S]*\)/);
  });

  it("reads bounded raw activity rows instead of the full deduping activity view", () => {
    const currentActivitySql = extractCteSql(modelSql, "current_activity");

    expect(currentActivitySql).toContain("source('postgres_fitness', 'activity')");
    expect(currentActivitySql).toMatch(
      /WHERE _peerdb_is_deleted = 0\s+AND provider_absent_at IS null\s+AND deleted_at IS null/,
    );
    expect(currentActivitySql).not.toContain("analytics.v_activity");
  });

  it("emits one deterministic ACSM estimate per activity", () => {
    const acsmEstimateSql = extractCteSql(modelSql, "acsm_estimates");

    expect(acsmEstimateSql).toContain("max(");
    expect(acsmEstimateSql).toContain("GROUP BY");
    expect(acsmEstimateSql).toContain("acsm_segments.activity_id");
    expect(acsmEstimateSql).toContain("acsm_segments.user_id");
    expect(acsmEstimateSql).toContain("acsm_segments.started_at");
  });
});
