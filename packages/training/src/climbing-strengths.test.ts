import { describe, expect, it } from "vitest";
import {
  ALL_CLIMBING_GRADES,
  climbingStrengthsAdjustedLabel,
  climbingStrengthsCountLabel,
  climbingStrengthsDifferenceLabel,
  climbingStrengthsGradePanel,
  climbingStrengthsRateLabel,
  climbingStrengthsResultLabel,
  climbingStrengthsSchema,
} from "./climbing-strengths.ts";

it("preserves additive recorded tag panels and selects their supplied pooled profile", () => {
  const profile = { grades: [], rows: [], progress: [] };
  const tagPanel = {
    ...profile,
    key: "tag-style",
    contextKey: "boulder",
    contextLabel: "Bouldering",
    dimension: "tag" as const,
    setting: null,
    category: { providerId: "kaya", key: "style", label: "Style" },
    allGrades: { ...profile, rows: [{ key: "technical", label: "Technical", cells: [] }] },
    gradeAdjustedStrengths: [],
    coverage: { missingTraits: 0, unknownOutcomes: 0 },
  };
  const parsed = climbingStrengthsSchema.parse({
    panels: [],
    tagPanels: [tagPanel],
    coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 },
  });
  expect(parsed.tagPanels).toEqual([tagPanel]);
  expect(climbingStrengthsGradePanel(tagPanel, ALL_CLIMBING_GRADES)).toMatchObject({
    dimension: "tag",
    category: tagPanel.category,
    rows: tagPanel.allGrades.rows,
  });
});

describe("climbing strengths labels", () => {
  it.each([
    [null, "No comparable results"],
    [0, "0 percentage points vs same-grade baseline"],
    [12.5, "+12.5 percentage points vs same-grade baseline"],
    [-7.2, "-7.2 percentage points vs same-grade baseline"],
  ] as const)("formats a supplied adjusted difference of %s", (value, label) => {
    expect(climbingStrengthsDifferenceLabel(value)).toBe(label);
  });
  it("labels unavailable, zero, limited and available adjusted observations", () => {
    expect(climbingStrengthsAdjustedLabel(undefined)).toBe("No comparable results");
    expect(
      climbingStrengthsAdjustedLabel({
        key: "slab",
        differencePercentagePoints: null,
        expectedSuccessRate: null,
        sampleStatus: "no_data",
      }),
    ).toBe("No comparable results");
    expect(
      climbingStrengthsAdjustedLabel({
        key: "slab",
        differencePercentagePoints: 0,
        expectedSuccessRate: 0,
        sampleStatus: "limited",
      }),
    ).toBe(
      "0 percentage points vs same-grade baseline · Expected send rate at these grades: 0% · Limited sample",
    );
    expect(
      climbingStrengthsAdjustedLabel({
        key: "slab",
        differencePercentagePoints: -7.2,
        expectedSuccessRate: 62.8,
        sampleStatus: "available",
      }),
    ).toBe(
      "-7.2 percentage points vs same-grade baseline · Expected send rate at these grades: 62.8%",
    );
  });
  it("distinguishes missing climbs, unknown results and recorded rates", () => {
    expect(climbingStrengthsRateLabel({ climbs: 0, successRate: null })).toBe("No data");
    expect(climbingStrengthsRateLabel({ climbs: 4, successRate: null })).toBe("Result unknown");
    expect(climbingStrengthsRateLabel({ climbs: 5, successRate: 67 })).toBe("67%");
    expect(climbingStrengthsRateLabel({ climbs: 5, successRate: 0 })).toBe("0%");
  });
  it("labels total climbs and recorded unknown-result counts", () => {
    expect(climbingStrengthsCountLabel({ sends: 1, climbs: 2, unknownOutcomes: 0 })).toBe(
      "1 send / 2 climbs",
    );
    expect(climbingStrengthsCountLabel({ sends: 2, climbs: 3, unknownOutcomes: 0 })).toBe(
      "2 sends / 3 climbs",
    );
    expect(climbingStrengthsCountLabel({ sends: 2, climbs: 5, unknownOutcomes: 2 })).toBe(
      "2 sends / 5 climbs · 2 results unknown",
    );
    expect(climbingStrengthsCountLabel({ sends: 0, climbs: 1, unknownOutcomes: 1 })).toBe(
      "0 sends / 1 climb · 1 result unknown",
    );
  });
  it("preserves unknown outcomes in source examples", () => {
    expect(climbingStrengthsResultLabel(null)).toBe("Result unknown");
    expect(climbingStrengthsResultLabel("sent")).toBe("Sent");
    expect(climbingStrengthsResultLabel("not_sent")).toBe("Not sent");
  });
});
