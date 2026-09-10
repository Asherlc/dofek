import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

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

  it("uses an ASOF join so Zone 2 efficiency does not require identical sample timestamps", () => {
    const z2SamplesSql = extractCteSql(modelSql, "z2_samples");
    const heartRateSamplesSql = extractCteSql(modelSql, "z2_heart_rate_samples");
    const powerSamplesSql = extractCteSql(modelSql, "z2_power_samples");

    expect(heartRateSamplesSql).toContain("channel = 'heart_rate'");
    expect(powerSamplesSql).toContain("channel = 'power'");
    expect(powerSamplesSql).toContain("AND scalar > 0");
    expect(z2SamplesSql).toContain("ASOF JOIN");
    expect(z2SamplesSql).toContain(`ON hr.user_id = pwr.user_id
        AND hr.activity_id = pwr.activity_id
        AND hr.recorded_at >= pwr.recorded_at`);
    expect(z2SamplesSql).not.toContain("WHERE pwr.scalar > 0");
    expect(z2SamplesSql).not.toContain("pwr.recorded_at = hr.recorded_at");
    expect(z2SamplesSql).toContain("HAVING count() >= 300");
  });

  it("emits soft-delete tombstones for activities missing from the computed result set", () => {
    expect(modelSql).toContain("if(z2_samples.activity_id IS NULL, 1, 0) AS is_deleted");
    expect(modelSql).toContain("FROM {{ this }} FINAL");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
  });
});
