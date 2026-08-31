import { describe, expect, it } from "vitest";
import {
  CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY,
  resolveClimbingGradePreference,
} from "./climbing-grade-preferences.ts";

describe("resolveClimbingGradePreference", () => {
  it("returns V Scale and YDS defaults when no valid preference is saved", () => {
    expect(resolveClimbingGradePreference(null)).toEqual({ boulder: "v_scale", route: "yds" });
    expect(resolveClimbingGradePreference({ boulder: "yds", route: "font" })).toEqual({
      boulder: "v_scale",
      route: "yds",
    });
  });

  it("keeps independent valid boulder and route systems", () => {
    expect(resolveClimbingGradePreference({ boulder: "font", route: "french" })).toEqual({
      boulder: "font",
      route: "french",
    });
  });

  it("uses the stable account-setting key", () => {
    expect(CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY).toBe("climbingGradeSystems");
  });
});
