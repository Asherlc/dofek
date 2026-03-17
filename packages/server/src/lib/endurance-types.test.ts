import { describe, expect, it } from "vitest";
import { ENDURANCE_ACTIVITY_TYPES, enduranceTypeFilter } from "./endurance-types.ts";

describe("ENDURANCE_ACTIVITY_TYPES", () => {
  it("contains expected endurance activities", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("cycling");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("running");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("swimming");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("walking");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("hiking");
  });

  it("does not include non-endurance types", () => {
    const types: readonly string[] = ENDURANCE_ACTIVITY_TYPES;
    expect(types).not.toContain("strength");
    expect(types).not.toContain("yoga");
  });
});

describe("enduranceTypeFilter", () => {
  it("generates SQL IN clause with the given alias", () => {
    const result = enduranceTypeFilter("a");
    const sqlString = result.queryChunks.map((c) => c.value ?? c).join("");
    expect(sqlString).toContain("a.activity_type IN (");
    expect(sqlString).toContain("'cycling'");
    expect(sqlString).toContain("'running'");
    expect(sqlString).toContain("'swimming'");
    expect(sqlString).toContain("'walking'");
    expect(sqlString).toContain("'hiking'");
  });

  it("uses the provided alias in the output", () => {
    const result = enduranceTypeFilter("asum");
    const sqlString = result.queryChunks.map((c) => c.value ?? c).join("");
    expect(sqlString).toContain("asum.activity_type");
  });
});
