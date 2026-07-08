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

    expect(activitySummarySql).toContain(
      "activity_type IN ('walking', 'hiking', 'trail_running')",
    );
    expect(activitySummarySql).toContain("is_deleted = 0");
  });

  it("precomputes hiking page activity metrics", () => {
    expect(modelSql).toContain("duration_seconds");
    expect(modelSql).toContain("average_pace_min_per_km");
    expect(modelSql).toContain("average_grade_percent");
    expect(modelSql).toContain("elevation_gain_m");
    expect(modelSql).toContain("elevation_loss_m");
    expect(modelSql).toContain("avg_heart_rate");
  });

  it("emits tombstones for activities that leave the hiking activity set", () => {
    const tombstoneRowsSql = extractCteSql(modelSql, "tombstone_rows");

    expect(modelSql).toContain("existing_hiking_activity AS (");
    expect(tombstoneRowsSql).toContain("existing_hiking_activity.activity_id AS activity_id");
    expect(tombstoneRowsSql).toContain("1 AS is_deleted");
    expect(tombstoneRowsSql).toContain("WHERE active_rows.activity_id IS NULL");
  });
});
