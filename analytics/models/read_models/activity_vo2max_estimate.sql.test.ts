import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_vo2max_estimate.sql");

describe("activity_vo2max_estimate model", () => {
  it("includes canonical running in the upstream activity filter", () => {
    const currentActivitySql = extractCteSql(modelSql, "current_activity");

    expect(currentActivitySql).toMatch(/canonical_type IN \([\s\S]*'running'[\s\S]*\)/);
  });

  it("publishes stable group ids from deduped activities", () => {
    const currentActivitySql = extractCteSql(modelSql, "current_activity");

    expect(currentActivitySql).toContain("ref('deduped_activities')");
    expect(currentActivitySql).toContain("activity_id");
    expect(currentActivitySql).toContain("WHERE is_deleted = 0");
    expect(currentActivitySql).not.toContain("analytics.v_activity");
  });

  it("maps changed raw members through persisted group identity", () => {
    const changedRawActivitySql = extractCteSql(modelSql, "changed_raw_activity");
    const sourceDirtyKeysSql = extractCteSql(modelSql, "activity_source_dirty_keys");

    expect(changedRawActivitySql).toContain("group_id AS activity_id");
    expect(changedRawActivitySql).not.toMatch(/^\s*id AS activity_id/m);
    expect(sourceDirtyKeysSql).toContain(
      "changed_raw_activity.activity_id = current_activity.activity_id",
    );
    expect(sourceDirtyKeysSql).not.toContain(
      "changed_raw_activity.id = current_activity.activity_id",
    );
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
