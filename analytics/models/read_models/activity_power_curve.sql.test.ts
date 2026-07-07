import { describe, expect, it } from "vitest";
import { extractCteSql, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("activity_power_curve.sql");

describe("activity_power_curve model", () => {
  it("limits upstream activities to endurance types", () => {
    const activityBoundsSql = extractCteSql(modelSql, "activity_bounds");

    expect(activityBoundsSql).toContain("activity_type IN ('cycling', 'road_cycling'");
    expect(activityBoundsSql).toContain("is_deleted = 0");
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
