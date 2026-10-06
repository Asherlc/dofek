import { DEFAULT_CLIMBING_GRADE_PREFERENCE } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import { displayClimbingGrade } from "./climbing-grade-display.ts";

describe("displayClimbingGrade", () => {
  it("keeps valid grades in the preferred source system", () => {
    expect(
      displayClimbingGrade(DEFAULT_CLIMBING_GRADE_PREFERENCE, "boulder", "v_scale", "V4"),
    ).toEqual({ grade: "V4", gradeSystem: "v_scale", gradeSortValue: 65 });
  });

  it("converts grades to each climb type's selected display system", () => {
    const preference = { boulder: "font", route: "french" } as const;
    expect(displayClimbingGrade(preference, "boulder", "v_scale", "V4")).toEqual({
      grade: "6a+/6b+",
      gradeSystem: "font",
      gradeSortValue: 65,
    });
    expect(displayClimbingGrade(preference, "route", "yds", "5.10c")).toEqual({
      grade: "6b",
      gradeSystem: "french",
      gradeSortValue: 64.5,
    });
  });

  it("rejects incompatible grade systems and unparseable grades", () => {
    expect(
      displayClimbingGrade(DEFAULT_CLIMBING_GRADE_PREFERENCE, "route", "v_scale", "V4"),
    ).toBeNull();
    expect(
      displayClimbingGrade(DEFAULT_CLIMBING_GRADE_PREFERENCE, "boulder", "v_scale", "unknown"),
    ).toBeNull();
  });
});
