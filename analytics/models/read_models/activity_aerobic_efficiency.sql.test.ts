import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_aerobic_efficiency.sql");

describe("activity_aerobic_efficiency model", () => {
  it("uses the same resting heart rate fallback as the live repository path", () => {
    const activityMetaSql = extractCteSql(modelSql, "activity_meta");

    expect(activityMetaSql).toContain(
      "coalesce(resting_by_activity.resting_hr, user_profile.resting_hr, 60) AS resting_hr",
    );
  });

  it("selects resting heart rate from the most recent sleep window before the activity", () => {
    const restingByActivitySql = extractCteSql(modelSql, "resting_by_activity");

    expect(restingByActivitySql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(restingByActivitySql).toContain("argMax(resting.resting_hr, toDate(resting.ended_at))");
    expect(restingByActivitySql).toContain("toDate(resting.ended_at) <= toDate(activity_bounds.started_at)");
  });

  it("joins heart rate and power samples at matching timestamps for Z2 efficiency", () => {
    const z2SamplesSql = extractCteSql(modelSql, "z2_samples");

    expect(z2SamplesSql).toContain("channel = 'heart_rate'");
    expect(z2SamplesSql).toContain("channel = 'power'");
    expect(z2SamplesSql).toContain("pwr.recorded_at = hr.recorded_at");
    expect(z2SamplesSql).toContain("HAVING count() >= 300");
  });

  it("emits soft-delete tombstones for activities missing from the computed result set", () => {
    expect(modelSql).toContain("if(z2_samples.activity_id IS NULL, 1, 0) AS is_deleted");
    expect(modelSql).toContain("FROM {{ this }} FINAL");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
  });
});
