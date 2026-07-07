import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelSql = readFileSync(new URL("./activity_power_curve.sql", import.meta.url), "utf8");

describe("activity_power_curve model", () => {
  it("limits upstream activities to endurance types", () => {
    expect(modelSql).toContain("activity_type IN ('cycling', 'road_cycling'");
  });

  it("emits per-duration tombstones for deleted activities", () => {
    expect(modelSql).toContain("existing_duration_rows AS (");
    expect(modelSql).toContain("tombstone_rows AS (");
    expect(modelSql).toContain("existing_duration_rows.duration_seconds AS duration_seconds");
    expect(modelSql).toContain("FROM tombstone_rows");
  });
});
