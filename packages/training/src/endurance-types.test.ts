import { describe, expect, it } from "vitest";
import { ENDURANCE_ACTIVITY_TYPES, isEnduranceActivity } from "./endurance-types.ts";

describe("ENDURANCE_ACTIVITY_TYPES", () => {
  it("includes cycling, running, swimming, walking, hiking", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("cycling");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("running");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("swimming");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("walking");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("hiking");
  });

  it("does not include strength activities", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).not.toContain("strength_training");
    expect(ENDURANCE_ACTIVITY_TYPES).not.toContain("yoga");
  });
});

describe("isEnduranceActivity", () => {
  it("returns true for endurance types", () => {
    expect(isEnduranceActivity("cycling")).toBe(true);
    expect(isEnduranceActivity("running")).toBe(true);
    expect(isEnduranceActivity("swimming")).toBe(true);
  });

  it("returns false for non-endurance types", () => {
    expect(isEnduranceActivity("strength_training")).toBe(false);
    expect(isEnduranceActivity("yoga")).toBe(false);
    expect(isEnduranceActivity("")).toBe(false);
  });
});
