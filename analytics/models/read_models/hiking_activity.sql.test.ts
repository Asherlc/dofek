import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("hiking_activity.sql");

describe("hiking_activity model", () => {
  it("materializes one serving row per walking, hiking, or trail-running activity", () => {
    expect(modelSql).toContain("materialized='incremental'");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(modelSql).toContain("order_by='(user_id, activity_id)'");
    expect(modelSql).toContain("ref('activity_summary_rows') }} FINAL");

    const activitySummarySql = extractCteSql(modelSql, "activity_summary");

    expect(activitySummarySql).toContain("canonical_type IN ('walking', 'hiking')");
    expect(activitySummarySql).toContain(
      "canonical_type = 'running' AND modality = 'trail'",
    );
    expect(activitySummarySql).toContain("is_deleted = 0");
    expect(activitySummarySql).toContain("refreshed_at");
    expect(activitySummarySql).not.toContain("ended_at IS NOT NULL");
  });

  it("limits incremental active row rewrites to changed activity summary rows", () => {
    const activeRowsSql = extractCteSql(modelSql, "active_rows");
    const dirtyKeysSql = extractCteSql(modelSql, "activity_summary_dirty_keys");

    expect(modelSql).toContain("target_state AS (");
    expect(dirtyKeysSql).toContain("activity_summary.refreshed_at > target_state.last_refreshed_at");
    expect(activeRowsSql).toContain("INNER JOIN activity_summary_dirty_keys");
    expect(activeRowsSql).toContain(
      "activity_summary_dirty_keys.activity_id = activity_summary.activity_id",
    );
    expect(activeRowsSql).toContain("activity_summary_dirty_keys.user_id = activity_summary.user_id");
  });

  it("precomputes hiking page activity metrics", () => {
    expect(modelSql).toContain("duration_seconds");
    expect(modelSql).toContain("average_pace_min_per_km");
    expect(modelSql).toContain("average_grade_percent");
    expect(modelSql).toContain("elevation_gain_m");
    expect(modelSql).toContain("elevation_loss_m");
    expect(modelSql).toContain("avg_heart_rate");
    expect(modelSql).toContain("activity_summary.ended_at IS NOT null");
  });

  it("emits tombstones for activities that leave the hiking activity set", () => {
    const tombstoneRowsSql = extractCteSql(modelSql, "tombstone_rows");

    expect(modelSql).toContain("existing_hiking_activity AS (");
    expect(tombstoneRowsSql).toContain("existing_hiking_activity.activity_id AS activity_id");
    expect(tombstoneRowsSql).toContain("1 AS is_deleted");
    expect(tombstoneRowsSql).toContain("LEFT JOIN activity_summary");
    expect(tombstoneRowsSql).toContain("WHERE activity_summary.activity_id IS NULL");
  });
});
