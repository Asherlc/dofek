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
    expect(powerSampleGroupsSql).toContain("WHERE (sensor.user_id, sensor.activity_id) IN (");
    expect(powerSampleGroupsSql).toContain("FROM activity_bounds");
    expect(powerSampleGroupsSql).toContain(
      "INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL",
    );
  });

  it("uses the approved standard duration set", () => {
    const durationValuesSql = extractCteSql(modelSql, "duration_values");

    expect(durationValuesSql).toContain(
      "arrayJoin([1, 5, 15, 30, 60, 120, 300, 600, 720, 1200, 1800, 2400, 3600, 5400])",
    );
  });

  it("preserves measured zero power samples", () => {
    const powerSampleGroupsSql = extractCteSql(modelSql, "power_sample_groups");

    expect(powerSampleGroupsSql).toContain("sensor.scalar >= 0");
    expect(powerSampleGroupsSql).not.toContain("sensor.scalar > 0");
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
