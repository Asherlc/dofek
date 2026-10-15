import { parseClimbingGrade } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import { normalizeMountainProjectGrade, parseMountainProjectGrades } from "./grades.ts";

describe("normalizeMountainProjectGrade", () => {
  it.each([
    ["5.7", "5.7"],
    ["5.10b/c", "5.10b"],
    ["5.7 PG13", "5.7"],
    ["5.5 WI2+ M2-3 Mod. Snow", "5.5"],
    ["V2", "V2"],
    ["V0-", "V0"],
    ["V0+", "V0"],
    ["V2-3", "V2"],
  ])("normalizes %s through the canonical parser", (rating, canonicalToken) => {
    expect(normalizeMountainProjectGrade(rating)).toEqual(parseClimbingGrade(canonicalToken));
  });

  it.each(["WI4", "M6+", "Mod. Snow", "3rd", "4th", ""])("skips unsupported grade %s", (rating) => {
    expect(normalizeMountainProjectGrade(rating)).toBeNull();
  });
});

describe("parseMountainProjectGrades", () => {
  it("preserves all independent technical scales across source whitespace", () => {
    expect(parseMountainProjectGrades(" \tWI4\t\tAI3\nM5+  C2 \n")).toEqual([
      { value: "WI4", system: "water_ice" },
      { value: "AI3", system: "alpine_ice" },
      { value: "M5+", system: "mixed" },
      { value: "C2", system: "aid" },
    ]);
  });
  it.each(["WIbad", "AIbad", "M5junk", "C2junk"])(
    "retains invalid technical grade %s as unknown text",
    (rating) => {
      expect(parseMountainProjectGrades(rating)).toEqual([{ value: rating, system: null }]);
    },
  );
  it("trims unknown recorded text and treats whitespace as an empty rating", () => {
    expect(parseMountainProjectGrades(" \tMod. Snow\n ")).toEqual([
      { value: "Mod. Snow", system: null },
    ]);
    expect(parseMountainProjectGrades(" \t\n ")).toEqual([]);
  });
  it("retains each recognized component of a compound rating in source order", () => {
    expect(parseMountainProjectGrades("5.5 WI2+ M2-3 Mod. Snow")).toEqual([
      { value: "5.5", system: "yds" },
      { value: "WI2+", system: "water_ice" },
      { value: "M2-3", system: "mixed" },
    ]);
    expect(parseMountainProjectGrades("5.10 A2 PG13")).toEqual([
      { value: "5.10", system: "yds" },
      { value: "A2", system: "aid" },
    ]);
  });
  it("retains an unrecognized recorded grade and permits an empty rating", () => {
    expect(parseMountainProjectGrades("Mod. Snow")).toEqual([{ value: "Mod. Snow", system: null }]);
    expect(parseMountainProjectGrades("")).toEqual([]);
  });
});
