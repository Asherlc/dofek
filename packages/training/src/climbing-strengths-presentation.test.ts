import { expect, it } from "vitest";
import type {
  ClimbingStrengthsDisplayPanel,
  ClimbingStrengthsPanel,
} from "./climbing-strengths.ts";
import {
  climbingStrengthsBreakdownKey,
  climbingStrengthsBreakdownOptions,
  climbingStrengthsDefaultBreakdown,
  climbingStrengthsPanelLabel,
} from "./climbing-strengths-presentation.ts";

const base: ClimbingStrengthsPanel = {
  key: "base",
  contextKey: "boulder",
  contextLabel: "Bouldering",
  dimension: "wall_angle",
  setting: null,
  grades: [],
  rows: [
    {
      key: "row",
      label: "Recorded",
      cells: [
        {
          grade: "V3",
          sends: 0,
          climbs: 1,
          unknownOutcomes: 1,
          successRate: null,
          differencePercentagePoints: null,
          sampleStatus: "limited",
          examples: [],
        },
      ],
    },
  ],
  progress: [],
  allGrades: { grades: [], rows: [], progress: [] },
  gradeAdjustedStrengths: [],
  coverage: { missingTraits: 0, unknownOutcomes: 1 },
};
const tag: ClimbingStrengthsDisplayPanel = {
  ...base,
  dimension: "tag",
  category: { providerId: "kaya", key: null, label: "Custom category" },
};
it("uses provider/category identity, preserves supplied labels, and deduplicates contexts", () => {
  const otherProvider = { ...tag, category: { ...tag.category, providerId: "other" } };
  const otherCategory = { ...tag, category: { ...tag.category, key: "null" } };
  expect(new Set([tag, otherProvider, otherCategory].map(climbingStrengthsBreakdownKey)).size).toBe(
    3,
  );
  expect(
    climbingStrengthsBreakdownOptions([base, tag, { ...tag, key: "other-context" }, otherProvider]),
  ).toEqual([
    { key: "wall_angle", label: "Wall angle", providerId: null },
    { key: "hold_type", label: "Hold type", providerId: null },
    { key: climbingStrengthsBreakdownKey(tag), label: "Custom category", providerId: "kaya" },
    {
      key: climbingStrengthsBreakdownKey(otherProvider),
      label: "Custom category",
      providerId: "other",
    },
  ]);
  expect(climbingStrengthsPanelLabel(tag)).toBe("Custom category");
});
it("keeps existing observed defaults before tag categories, including unknown results", () => {
  const holds = { ...base, dimension: "hold_type" as const };
  const empty = { ...base, rows: [] };
  expect(climbingStrengthsDefaultBreakdown([tag, holds, base])).toBe("wall_angle");
  expect(climbingStrengthsDefaultBreakdown([empty, tag, holds])).toBe("hold_type");
  expect(climbingStrengthsDefaultBreakdown([empty, tag])).toBe(climbingStrengthsBreakdownKey(tag));
  expect(climbingStrengthsDefaultBreakdown([])).toBe("wall_angle");
  expect(climbingStrengthsBreakdownOptions([{ ...tag, rows: [] }])).toHaveLength(2);
});
