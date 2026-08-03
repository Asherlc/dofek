import { describe, expect, it } from "vitest";
import { formatNutritionDataQualityMessages } from "./nutrition-data-quality.ts";

describe("formatNutritionDataQualityMessages", () => {
  it("formats bounded-window coverage and overlap", () => {
    expect(
      formatNutritionDataQualityMessages({
        selectedWindowDays: 30,
        daysWithData: 12,
        usableDays: 10,
        overlapDays: 3,
        conflictDays: 2,
        completenessPercent: 33.3,
      }),
    ).toEqual({
      recorded: "Nutrition data exists on 12 selected days.",
      coverage: "10 of 30 selected days are usable (33.3% completeness).",
      overlap: "3 days contain overlapping sources; 2 remain unresolved.",
    });
  });

  it("formats all-history coverage without inventing a denominator", () => {
    expect(
      formatNutritionDataQualityMessages({
        selectedWindowDays: null,
        daysWithData: 20,
        usableDays: 20,
        overlapDays: 0,
        conflictDays: 0,
        completenessPercent: null,
      }),
    ).toEqual({
      recorded: "Nutrition data exists on 20 selected days.",
      coverage: "20 recorded days are usable.",
      overlap: "No overlapping nutrition sources detected.",
    });
  });

  it("uses singular overlap wording", () => {
    expect(
      formatNutritionDataQualityMessages({
        selectedWindowDays: 7,
        daysWithData: 1,
        usableDays: 0,
        overlapDays: 1,
        conflictDays: 1,
        completenessPercent: 0,
      }).overlap,
    ).toBe("1 day contains overlapping sources; 1 remains unresolved.");
  });
});
