import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

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

  it("computes duration candidates from materialized endpoints and cumulative state", () => {
    expect(modelSql).toContain("power_sample_groups AS (");
    expect(modelSql).toContain("power_sample_endpoints AS MATERIALIZED (");
    expect(modelSql).toContain("cumulative_discontinuities");
    expect(modelSql).toContain("INNER JOIN power_sample_endpoints AS end_sample");
    expect(modelSql).not.toContain("ANY INNER JOIN power_sample_endpoints AS end_sample");
    expect(modelSql).not.toContain("arrayFirstIndex(");
    expect(modelSql).not.toContain("arraySlice(");
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
