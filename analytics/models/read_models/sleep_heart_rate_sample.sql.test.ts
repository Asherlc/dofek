import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("sleep_heart_rate_sample.sql");

describe("sleep_heart_rate_sample model", () => {
  it("discovers dirty sleeps from daily heart-rate freshness keys instead of all sensor samples", () => {
    const heartRateRefreshesSql = extractCteSql(modelSql, "heart_rate_refreshes");
    const normalizedHeartRateRefreshesSql = heartRateRefreshesSql.replace(/\s+/g, " ");

    expect(heartRateRefreshesSql).toContain("ref('heart_rate_day_freshness')");
    expect(heartRateRefreshesSql).not.toContain("ref('deduped_sensor')");
    expect(normalizedHeartRateRefreshesSql).toContain("has_live_samples");
    expect(normalizedHeartRateRefreshesSql).toContain(
      "day_freshness.recorded_date >= toDate(active_sleep.started_at)",
    );
    expect(normalizedHeartRateRefreshesSql).toContain(
      "day_freshness.recorded_date <= toDate(active_sleep.ended_at)",
    );
  });

  it("bounds the deduped sensor scan to dirty sleep dates", () => {
    const currentSamplesSql = extractCteSql(modelSql, "current_samples");

    expect(modelSql).toContain("dirty_sleep_dates AS (");
    expect(currentSamplesSql).toContain("(samples.user_id, samples.recorded_date) IN (");
    expect(currentSamplesSql).toContain("FROM dirty_sleep_dates");
  });

  it("reuses materialized current sleep state (DOFEK-SERVER-5A)", () => {
    const currentSleepStateSql = extractCteSql(modelSql, "current_sleep_state");
    const activeDirtySleepSql = extractCteSql(modelSql, "active_dirty_sleep");

    expect(modelSql).toContain("'enable_materialized_cte': 1");
    expect(currentSleepStateSql).toContain("active_sleep.ended_at AS ended_at");
    expect(currentSleepStateSql).toContain("active_sleep.duration_seconds AS duration_seconds");
    expect(activeDirtySleepSql).toContain("FROM current_sleep_state");
    expect(activeDirtySleepSql).not.toContain("FROM active_sleep");
    expect(activeDirtySleepSql).not.toContain("heart_rate_refreshes");
    expect(activeDirtySleepSql).not.toContain("activity_refreshes");
  });
});
