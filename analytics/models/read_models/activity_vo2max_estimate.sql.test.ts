import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelSql = readFileSync(new URL("./activity_vo2max_estimate.sql", import.meta.url), "utf8");

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

describe("activity_vo2max_estimate model", () => {
  it("includes trail running in the upstream activity filter", () => {
    expect(cteSql("current_activity")).toContain("'trail_running'");
  });

  it("reads bounded raw activity rows instead of the full deduping activity view", () => {
    const currentActivitySql = cteSql("current_activity");

    expect(currentActivitySql).toContain("source('postgres_fitness', 'activity')");
    expect(currentActivitySql).toContain("_peerdb_is_deleted = 0");
    expect(currentActivitySql).not.toContain("analytics.v_activity");
  });

  it("emits one deterministic ACSM estimate per activity", () => {
    const acsmEstimateSql = cteSql("acsm_estimates");

    expect(acsmEstimateSql).toContain("max(");
    expect(acsmEstimateSql).toContain("GROUP BY");
    expect(acsmEstimateSql).toContain("acsm_segments.activity_id");
    expect(acsmEstimateSql).toContain("acsm_segments.user_id");
    expect(acsmEstimateSql).toContain("acsm_segments.started_at");
  });
});
