import { DEFAULT_CLIMBING_GRADE_PREFERENCE } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import {
  displayClimbingGrade,
  displayGradeComponents,
  selectRockClimbingGrade,
} from "./climbing-grade-display.ts";

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
    expect(
      displayClimbingGrade(DEFAULT_CLIMBING_GRADE_PREFERENCE, "summit", "yds", "5.10a"),
    ).toBeNull();
  });
});

describe("grade component selection", () => {
  const preference = DEFAULT_CLIMBING_GRADE_PREFERENCE;
  it.each([null, "summit"] as const)("preserves all raw components for kind %s", (kind) => {
    const grades = [
      { value: "PD", system: "ifas" },
      { value: "Snow", system: null },
    ] as const;
    expect(displayGradeComponents(preference, kind, grades)).toBe("PD Snow");
    expect(selectRockClimbingGrade(preference, kind, grades)).toBeNull();
  });
  it("selects the preferred route system while retaining independent aid and unknown components in order", () => {
    const grades = [
      { value: "6b", system: "french" },
      { value: "A1", system: "aid" },
      { value: "5.10a", system: "yds" },
      { value: "Source text", system: null },
    ] as const;
    expect(displayGradeComponents(preference, "route", grades)).toBe("A1 5.10a Source text");
    expect(selectRockClimbingGrade(preference, "route", grades)).toEqual({
      grade: "5.10a",
      gradeSystem: "yds",
      gradeSortValue: 59,
    });
  });
  it("uses the first compatible component when the preferred system is absent", () => {
    const grades = [
      { value: "6b", system: "font" },
      { value: "6c", system: "font" },
    ] as const;
    expect(displayGradeComponents(preference, "boulder", grades)).toBe("V4");
    expect(selectRockClimbingGrade(preference, "boulder", grades)).toEqual({
      grade: "V4",
      gradeSystem: "v_scale",
      gradeSortValue: 64.5,
    });
  });
  it("displays incompatible and unknown scales without using them as rock performance grades", () => {
    const grades = [
      { value: "V4", system: "v_scale" },
      { value: "Unrated", system: null },
    ] as const;
    expect(displayGradeComponents(preference, "route", grades)).toBe("V4 Unrated");
    expect(selectRockClimbingGrade(preference, "route", grades)).toBeNull();
    expect(displayGradeComponents(preference, "route", [])).toBeNull();
    expect(selectRockClimbingGrade(preference, "boulder", [])).toBeNull();
  });
  it("retains unparseable source text and does not invent a numeric grade", () => {
    const grades = [{ value: "Source grade", system: "yds" }] as const;
    expect(displayGradeComponents(preference, "route", grades)).toBe("Source grade");
    expect(selectRockClimbingGrade(preference, "route", grades)).toBeNull();
  });
});
