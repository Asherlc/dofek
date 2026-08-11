import { describe, expect, it } from "vitest";
import {
  convertClimbingGrade,
  gradeOptionsForSystem,
  gradeSortValue,
  gradeSystemLabel,
  gradeSystemsForClimbType,
  isGradeSystemForClimbType,
  isValidClimbingGrade,
  parseClimbingGrade,
  resolveClimbingGradePreference,
} from "./climbing-grades.ts";

describe("parseClimbingGrade", () => {
  it("uses Sandbag's compatible systems and conversions", () => {
    expect(gradeSystemsForClimbType("boulder")).toEqual(["v_scale", "font"]);
    expect(gradeSystemsForClimbType("route")).toEqual([
      "yds",
      "french",
      "uiaa",
      "ewbank",
      "saxon",
      "norwegian",
      "brazilian_crux",
    ]);
    expect(gradeOptionsForSystem("font")).toContain("6a");
    expect(isGradeSystemForClimbType("font", "boulder")).toBe(true);
    expect(isGradeSystemForClimbType("font", "route")).toBe(false);
    expect(isValidClimbingGrade("6a", "font")).toBe(true);
    expect(isValidClimbingGrade("V4", "font")).toBe(false);
    expect(
      convertClimbingGrade({
        grade: "V4",
        sourceSystem: "v_scale",
        displaySystem: "font",
      }),
    ).toEqual({ displayGrade: "6a+/6b+", displaySystem: "font", sortValue: 65 });
    expect(
      convertClimbingGrade({
        grade: "V4",
        sourceSystem: "v_scale",
        displaySystem: "yds",
      }),
    ).toBeNull();
  });

  it.each([
    "v_scale",
    "font",
    "yds",
    "french",
    "uiaa",
    "ewbank",
    "saxon",
    "norwegian",
    "brazilian_crux",
  ] as const)("validates and preserves %s grades", (system) => {
    const grade = gradeOptionsForSystem(system)[0];
    if (!grade) throw new Error(`Sandbag returned no grades for ${system}`);

    expect(isValidClimbingGrade(grade, system)).toBe(true);
    expect(
      convertClimbingGrade({ grade, sourceSystem: system, displaySystem: system }),
    ).toMatchObject({ displayGrade: grade, displaySystem: system });
  });

  it.each([
    ["v_scale", "boulder", "route"],
    ["font", "boulder", "route"],
    ["yds", "route", "boulder"],
    ["french", "route", "boulder"],
    ["uiaa", "route", "boulder"],
    ["ewbank", "route", "boulder"],
    ["saxon", "route", "boulder"],
    ["norwegian", "route", "boulder"],
    ["brazilian_crux", "route", "boulder"],
  ] as const)("accepts %s only for %s climbs", (system, matchingType, mismatchingType) => {
    expect(isGradeSystemForClimbType(system, matchingType)).toBe(true);
    expect(isGradeSystemForClimbType(system, mismatchingType)).toBe(false);
  });

  it("uses defaults only when a grade preference is malformed or absent", () => {
    expect(resolveClimbingGradePreference({ boulder: "font", route: "french" })).toEqual({
      boulder: "font",
      route: "french",
    });
    expect(resolveClimbingGradePreference({ boulder: "font", route: "v_scale" })).toEqual({
      boulder: "v_scale",
      route: "yds",
    });
    expect(resolveClimbingGradePreference(null)).toEqual({ boulder: "v_scale", route: "yds" });
    expect(resolveClimbingGradePreference({ boulder: "font" })).toEqual({
      boulder: "v_scale",
      route: "yds",
    });
    expect(resolveClimbingGradePreference({ boulder: "v_scale", route: "font" })).toEqual({
      boulder: "v_scale",
      route: "yds",
    });
  });

  it("uses Sandbag scores only for valid, scored grades", () => {
    expect(gradeSortValue("V4", "v_scale")).toBe(65);
    expect(gradeSortValue("5.10", "yds")).toBe(63.5);
    expect(gradeSortValue("V-not-a-grade", "v_scale")).toBeNull();
    expect(gradeSystemLabel("uiaa")).toBe(
      "International Climbing and Mountaineering Federation (UIAA)",
    );
  });
  it("normalizes V-scale grades and orders them by Sandbag score", () => {
    const parsedGrades = ["VB", "V0", "V1", "V5", "V10"].map(parseClimbingGrade);

    expect(parsedGrades.map((grade) => grade?.grade)).toEqual(["VB", "V0", "V1", "V5", "V10"]);
    expect(parsedGrades.every((grade) => grade?.gradeSystem === "v_scale")).toBe(true);
    expect(parsedGrades.map((grade) => grade?.sortValue)).toEqual(
      [...parsedGrades.map((grade) => grade?.sortValue)].sort(
        (left, right) => Number(left) - Number(right),
      ),
    );
  });

  it("normalizes V-scale case and whitespace", () => {
    expect(parseClimbingGrade(" v5 ")).toEqual({
      gradeSystem: "v_scale",
      grade: "V5",
      sortValue: 69,
    });
    expect(parseClimbingGrade(" vb ")).toEqual({
      gradeSystem: "v_scale",
      grade: "VB",
      sortValue: 17.5,
    });
  });

  it("returns null for invalid V-scale labels instead of treating them as zero", () => {
    expect(parseClimbingGrade("V")).toBeNull();
    expect(parseClimbingGrade("V01")).toBeNull();
    expect(parseClimbingGrade("V-easy")).toBeNull();
    expect(parseClimbingGrade("V9007199254740993")).toBeNull();
    expect(parseClimbingGrade("not a grade")).toBeNull();
  });

  it("sorts Yosemite Decimal System letter grades in ascending order", () => {
    const labels = ["5.6", "5.10a", "5.10b", "5.10c", "5.10d", "5.11a", "5.12-"];
    const parsedGrades = labels.map((label) => parseClimbingGrade(label));
    const sortValues = parsedGrades.map((grade) => grade?.sortValue);

    expect(parsedGrades.every((grade) => grade !== null)).toBe(true);
    expect(parsedGrades.map((grade) => grade?.grade)).toEqual(labels);
    expect(parsedGrades.every((grade) => grade?.gradeSystem === "yds")).toBe(true);
    expect(sortValues).toEqual([...sortValues].sort((left, right) => Number(left) - Number(right)));
  });

  it("normalizes Yosemite Decimal System plus and minus variants", () => {
    expect(parseClimbingGrade(" 5.12- ")).toMatchObject({
      gradeSystem: "yds",
      grade: "5.12-",
    });
    expect(parseClimbingGrade("5.12")).toMatchObject({ gradeSystem: "yds", grade: "5.12" });
    expect(parseClimbingGrade("5.12+")).toMatchObject({ gradeSystem: "yds", grade: "5.12+" });
  });

  it("returns null for invalid Yosemite Decimal System labels", () => {
    expect(parseClimbingGrade("5")).toBeNull();
    expect(parseClimbingGrade("5.99")).toBeNull();
    expect(parseClimbingGrade("5.x")).toBeNull();
    expect(parseClimbingGrade("5.10aa")).toBeNull();
    expect(parseClimbingGrade("5.10b+")).toBeNull();
    expect(parseClimbingGrade("6.1")).toBeNull();
  });

  it("returns readable display grades with Sandbag sort values", () => {
    expect(parseClimbingGrade("v5")).toMatchObject({
      grade: "V5",
      sortValue: 69,
    });
    expect(parseClimbingGrade("5.10c")).toMatchObject({
      grade: "5.10c",
      sortValue: 64.5,
    });
  });
});
