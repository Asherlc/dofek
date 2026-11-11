import { expect, it } from "vitest";
import { buildClimbingStrengthProfile } from "./climbing-strength-profile.ts";

const baseline = [
  { grade: "V3", sends: 8, climbs: 10, unknownOutcomes: 0 },
  { grade: "V4", sends: 2, climbs: 10, unknownOutcomes: 0 },
];
it("adjusts for the grades each style was tried at instead of comparing pooled send rates", () => {
  const result = buildClimbingStrengthProfile({
    grades: baseline,
    rows: [
      { key: "easy", cells: [{ grade: "V3", sends: 8, climbs: 10, unknownOutcomes: 0 }] },
      { key: "hard", cells: [{ grade: "V4", sends: 2, climbs: 10, unknownOutcomes: 0 }] },
      { key: "strong", cells: [{ grade: "V4", sends: 1, climbs: 1, unknownOutcomes: 0 }] },
      { key: "weak", cells: [{ grade: "V3", sends: 0, climbs: 1, unknownOutcomes: 0 }] },
    ],
  });
  expect(result).toEqual([
    {
      key: "easy",
      expectedSuccessRate: 80,
      differencePercentagePoints: 0,
      sampleStatus: "available",
    },
    {
      key: "hard",
      expectedSuccessRate: 20,
      differencePercentagePoints: 0,
      sampleStatus: "available",
    },
    {
      key: "strong",
      expectedSuccessRate: 20,
      differencePercentagePoints: 80,
      sampleStatus: "limited",
    },
    {
      key: "weak",
      expectedSuccessRate: 80,
      differencePercentagePoints: -80,
      sampleStatus: "limited",
    },
  ]);
});
it("weights known outcomes and leaves unknown-only or missing observations unscored", () => {
  expect(
    buildClimbingStrengthProfile({
      grades: baseline,
      rows: [
        {
          key: "mixed",
          cells: [
            { grade: "V3", sends: 1, climbs: 4, unknownOutcomes: 3 },
            { grade: "V4", sends: 0, climbs: 4, unknownOutcomes: 1 },
          ],
        },
        { key: "unknown", cells: [{ grade: "V3", sends: 0, climbs: 5, unknownOutcomes: 5 }] },
        { key: "missing", cells: [] },
      ],
    }),
  ).toEqual([
    {
      key: "mixed",
      expectedSuccessRate: 35,
      differencePercentagePoints: -10,
      sampleStatus: "limited",
    },
    {
      key: "unknown",
      expectedSuccessRate: null,
      differencePercentagePoints: null,
      sampleStatus: "no_data",
    },
    {
      key: "missing",
      expectedSuccessRate: null,
      differencePercentagePoints: null,
      sampleStatus: "no_data",
    },
  ]);
});

it("excludes unknown baseline outcomes and treats five known results as available", () => {
  expect(
    buildClimbingStrengthProfile({
      grades: [{ grade: "V3", sends: 8, climbs: 30, unknownOutcomes: 20 }],
      rows: [
        { key: "five", cells: [{ grade: "V3", sends: 4, climbs: 14, unknownOutcomes: 9 }] },
        { key: "four", cells: [{ grade: "V3", sends: 3, climbs: 12, unknownOutcomes: 8 }] },
      ],
    }),
  ).toEqual([
    {
      key: "five",
      expectedSuccessRate: 80,
      differencePercentagePoints: 0,
      sampleStatus: "available",
    },
    {
      key: "four",
      expectedSuccessRate: 80,
      differencePercentagePoints: -5,
      sampleStatus: "limited",
    },
  ]);
});
