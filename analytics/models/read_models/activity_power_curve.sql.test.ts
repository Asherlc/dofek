import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "../../../src/db/read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_power_curve.sql");

describe("activity_power_curve model", () => {
  it("limits upstream activities to endurance types", () => {
    const activityBoundsSql = extractCteSql(modelSql, "activity_bounds");

    expect(activityBoundsSql).toContain(
      "canonical_type IN ('cycling', 'running', 'swimming', 'walking', 'hiking')",
    );
    expect(activityBoundsSql).toContain("is_deleted = 0");
  });

  it("limits incremental power work to changed activities with valid power samples", () => {
    const currentPowerActivitySql = extractCteSql(modelSql, "current_power_activity");
    const existingActivityStateSql = extractCteSql(modelSql, "existing_activity_state");
    const dirtyKeysSql = extractCteSql(modelSql, "source_dirty_activity_keys");
    const powerSampleGroupsSql = extractCteSql(modelSql, "power_sample_groups");
    const activityPowerSamplesSql = extractCteSql(modelSql, "activity_power_samples");
    const activityPowerSamplesPrewhere = activityPowerSamplesSql
      .split("\n")
      .find((line) => line.includes("PREWHERE"));

    expect(currentPowerActivitySql).toContain("current_activity.power_sample_count > 1");
    expect(currentPowerActivitySql).toContain(
      "current_activity.refreshed_at AS source_refreshed_at",
    );
    expect(modelSql).not.toContain("current_power_state AS (");
    expect(modelSql).toContain("'join_use_nulls': 1");
    expect(modelSql).toContain("max(refreshed_at) AS refreshed_at");
    expect(existingActivityStateSql).toContain("WHERE is_deleted = 0");
    expect(dirtyKeysSql).toContain(
      "source_refreshed_at > existing_activity_state.refreshed_at",
    );
    expect(modelSql).toContain(
      "power_curve_dirty_key_batch_size = var('power_curve_dirty_key_batch_size', 32)",
    );
    expect(modelSql).toContain("activity_keys AS MATERIALIZED (");
    expect(modelSql).toContain("LIMIT {{ power_curve_dirty_key_batch_size }}");
    // The channel filter must run before FINAL so the dedup state stays scoped
    // to power rows; is_deleted must stay after FINAL so a deleted latest
    // version cannot resurrect an older non-deleted one.
    expect(activityPowerSamplesSql).toContain("{{ ref('activity_sensor_sample') }} FINAL");
    expect(activityPowerSamplesPrewhere).toContain("channel = 'power'");
    expect(activityPowerSamplesPrewhere).not.toContain("is_deleted");
    expect(activityPowerSamplesSql).toContain("WHERE is_deleted = 0");
    expect(activityPowerSamplesSql).toContain("scalar >= 0");
    expect(activityPowerSamplesSql).toContain("(user_id, activity_id) IN (");
    expect(activityPowerSamplesSql).toContain("FROM activity_bounds");
    expect(powerSampleGroupsSql).toContain("INNER JOIN activity_power_samples AS sensor");
  });

  it("uses the required duration set while retaining legacy points", () => {
    const durationValuesSql = extractCteSql(modelSql, "duration_values");

    expect(durationValuesSql).toContain(
      "arrayJoin([1, 5, 15, 30, 60, 120, 180, 300, 420, 600, 720, 1200, 1800, 2400, 3600, 5400, 7200])",
    );
  });

  it("preserves measured zero power samples", () => {
    const activityPowerSamplesSql = extractCteSql(modelSql, "activity_power_samples");

    expect(activityPowerSamplesSql).toContain("scalar >= 0");
    expect(activityPowerSamplesSql).not.toContain("scalar > 0");
  });

  it("computes segment durations without correlated array indexing", () => {
    // Indexing a closed-over array from inside arrayMap (recorded_times[i])
    // makes ClickHouse replicate the whole array per element, which is O(N^2)
    // and allocated multiple GiB for a single large power activity.
    const powerSampleSegmentsSql = extractCteSql(modelSql, "power_sample_segments");

    expect(powerSampleSegmentsSql).toContain("arrayPopBack(recorded_times)");
    expect(powerSampleSegmentsSql).toContain("arrayPopFront(recorded_times)");
    expect(powerSampleSegmentsSql).not.toContain("recorded_times[");
  });

  it("integrates elapsed-time windows at fractional endpoints", () => {
    expect(modelSql).toContain("power_sample_groups AS (");
    expect(modelSql).toContain("cumulative_energy");
    expect(modelSql).toContain("cumulative_discontinuities");
    expect(modelSql).toContain("ASOF INNER JOIN power_sample_endpoints AS end_sample");
    expect(modelSql).toContain("end_sample.previous_power * greatest(");
    expect(modelSql).toContain("end_sample.recorded_offset");
    expect(modelSql).not.toContain("end_sample.recorded_at = addSeconds(");
  });

  it("emits offset, coverage, sampling quality, and source provenance", () => {
    const activeRowsSql = extractCteSql(modelSql, "active_rows");

    expect(activeRowsSql).toContain("start_offset_seconds");
    expect(activeRowsSql).toContain("observed_samples");
    expect(activeRowsSql).toContain("median_sample_interval_seconds");
    expect(activeRowsSql).toContain("largest_gap_seconds");
    expect(activeRowsSql).toContain("coverage_pct");
    expect(activeRowsSql).toContain("power_measurement_kind");
    expect(activeRowsSql).toContain("source_providers");
    expect(activeRowsSql).toContain("source_devices");
  });

  it("emits per-duration tombstones for deleted activities", () => {
    const tombstoneRowsSql = extractCteSql(modelSql, "tombstone_rows");

    expect(modelSql).toContain("existing_duration_rows AS (");
    expect(tombstoneRowsSql).toContain("existing_duration_rows.duration_seconds AS duration_seconds");
    expect(tombstoneRowsSql).toContain(
      "best_power_for_existing_duration.duration_seconds = existing_duration_rows.duration_seconds",
    );
    expect(tombstoneRowsSql).toContain(
      "WHERE best_power_for_existing_duration.activity_id IS NULL",
    );
    expect(modelSql).toContain("FROM tombstone_rows");
  });
});
