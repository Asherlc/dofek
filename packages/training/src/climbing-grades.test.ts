import { describe, expect, it } from "vitest";
import { parseClimbingGrade } from "./climbing-grades.ts";

describe("parseClimbingGrade", () => {
  it("normalizes V-scale grades and returns bouldering sort values", () => {
    expect(parseClimbingGrade("VB")).toEqual({
      gradeSystem: "v_scale",
      grade: "VB",
      sortValue: -1,
    });
    expect(parseClimbingGrade("V0")).toEqual({
      gradeSystem: "v_scale",
      grade: "V0",
      sortValue: 0,
    });
    expect(parseClimbingGrade("V1")).toEqual({
      gradeSystem: "v_scale",
      grade: "V1",
      sortValue: 1,
    });
    expect(parseClimbingGrade("V5")).toEqual({
      gradeSystem: "v_scale",
      grade: "V5",
      sortValue: 5,
    });
    expect(parseClimbingGrade("V10")).toEqual({
      gradeSystem: "v_scale",
      grade: "V10",
      sortValue: 10,
    });
  });

  it("normalizes V-scale case and whitespace", () => {
    expect(parseClimbingGrade(" v5 ")).toEqual({
      gradeSystem: "v_scale",
      grade: "V5",
      sortValue: 5,
    });
    expect(parseClimbingGrade(" vb ")).toEqual({
      gradeSystem: "v_scale",
      grade: "VB",
      sortValue: -1,
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

  it("normalizes Yosemite Decimal System plus and minus variants to deterministic neighboring values", () => {
    expect(parseClimbingGrade(" 5.12- ")).toEqual({
      gradeSystem: "yds",
      grade: "5.12-",
      sortValue: 5117,
    });
    expect(parseClimbingGrade("5.12")).toEqual({
      gradeSystem: "yds",
      grade: "5.12",
      sortValue: 5120,
    });
    expect(parseClimbingGrade("5.12+")).toEqual({
      gradeSystem: "yds",
      grade: "5.12+",
      sortValue: 5125,
    });
  });

  it("returns null for invalid Yosemite Decimal System labels", () => {
    expect(parseClimbingGrade("5")).toBeNull();
    expect(parseClimbingGrade("5.16")).toBeNull();
    expect(parseClimbingGrade("5.99")).toBeNull();
    expect(parseClimbingGrade("5.x")).toBeNull();
    expect(parseClimbingGrade("5.10aa")).toBeNull();
    expect(parseClimbingGrade("5.10b+")).toBeNull();
    expect(parseClimbingGrade("6.1")).toBeNull();
  });

  it("returns readable display grades with helper-only sort values", () => {
    expect(parseClimbingGrade("v5")).toMatchObject({
      grade: "V5",
      sortValue: 5,
    });
    expect(parseClimbingGrade("5.10c")).toMatchObject({
      grade: "5.10c",
      sortValue: 5103,
    });
  });
});
