import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelSql = readFileSync(new URL("./activity_aerobic_efficiency.sql", import.meta.url), "utf8");

function cteSql(name: string): string {
  const startMarker = `${name} AS (`;
  const startIndex = modelSql.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Could not find ${name} CTE`);
  }
  const bodyStartIndex = startIndex + startMarker.length;
  let parenthesisDepth = 1;
  let cursorIndex = bodyStartIndex;
  while (cursorIndex < modelSql.length && parenthesisDepth > 0) {
    const currentChar = modelSql[cursorIndex];
    if (currentChar === "(") parenthesisDepth += 1;
    if (currentChar === ")") parenthesisDepth -= 1;
    cursorIndex += 1;
  }
  if (parenthesisDepth !== 0) {
    throw new Error(`Could not find ${name} CTE end`);
  }
  return modelSql.slice(bodyStartIndex, cursorIndex - 1);
}

describe("activity_aerobic_efficiency model", () => {
  it("uses the same resting heart rate fallback as the live repository path", () => {
    const activityMetaSql = cteSql("activity_meta");

    expect(activityMetaSql).toContain(
      "coalesce(resting_by_activity.resting_hr, user_profile.resting_hr, 60) AS resting_hr",
    );
  });

  it("selects resting heart rate from the most recent sleep window before the activity", () => {
    const restingByActivitySql = cteSql("resting_by_activity");

    expect(restingByActivitySql).toContain("ref('resting_heart_rate_sleep_window')");
    expect(restingByActivitySql).toContain("argMax(resting.resting_hr, toDate(resting.ended_at))");
    expect(restingByActivitySql).toContain("toDate(resting.ended_at) <= toDate(activity_bounds.started_at)");
  });

  it("joins heart rate and power samples at matching timestamps for Z2 efficiency", () => {
    const z2SamplesSql = cteSql("z2_samples");

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
