import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_vo2max_estimate.sql");

describe("activity_vo2max_estimate model", () => {
  it("includes trail running in the upstream activity filter", () => {
    expect(extractCteSql(modelSql, "current_activity")).toContain("'trail_running'");
  });

  it("reads bounded raw activity rows instead of the full deduping activity view", () => {
    const currentActivitySql = extractCteSql(modelSql, "current_activity");

    expect(currentActivitySql).toContain("source('postgres_fitness', 'activity')");
    expect(currentActivitySql).toContain("_peerdb_is_deleted = 0");
    expect(currentActivitySql).toContain("provider_absent_at IS null");
    expect(currentActivitySql).toContain("deleted_at IS null");
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
