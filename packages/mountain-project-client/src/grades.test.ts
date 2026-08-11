import { parseClimbingGrade } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import { normalizeMountainProjectGrade } from "./grades.ts";

describe("normalizeMountainProjectGrade", () => {
  it.each([
    ["5.7", "5.7"],
    ["5.10b/c", "5.10b"],
    ["5.7 PG13", "5.7"],
    ["5.5 WI2+ M2-3 Mod. Snow", "5.5"],
    ["V2", "V2"],
  ])("normalizes %s through the canonical parser", (rating, canonicalToken) => {
    expect(normalizeMountainProjectGrade(rating)).toEqual(parseClimbingGrade(canonicalToken));
  });

  it.each(["WI4", "M6+", "Mod. Snow", "3rd", "4th", ""])("skips unsupported grade %s", (rating) => {
    expect(normalizeMountainProjectGrade(rating)).toBeNull();
  });
});
