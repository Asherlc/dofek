import { describe, expect, it } from "vitest";
import { dayNutritionPreviewSchema } from "./day-nutrition.ts";

const validPreview = {
  date: "2026-09-07",
  total_calories: 1450,
  protein_g: 98,
  carbs_g: 120,
  fat_g: 55,
  calorie_goal: {
    target: 2200,
    remaining: 750,
    over: 0,
    progress_percentage: 65.9,
    type: "configured" as const,
  },
  macros: {
    protein: { grams: 98, energy_share_percentage: 28 },
    carbs: { grams: 120, energy_share_percentage: 34 },
    fat: { grams: 55, energy_share_percentage: 38 },
  },
};

describe("dayNutritionPreviewSchema", () => {
  it("accepts a compact day calories and macros preview", () => {
    expect(dayNutritionPreviewSchema.parse(validPreview)).toEqual(validPreview);
  });

  it("rejects negative totals or energy shares outside 0-100", () => {
    expect(
      dayNutritionPreviewSchema.safeParse({
        ...validPreview,
        total_calories: -1,
      }).success,
    ).toBe(false);
    expect(
      dayNutritionPreviewSchema.safeParse({
        ...validPreview,
        macros: {
          ...validPreview.macros,
          protein: { grams: 10, energy_share_percentage: 101 },
        },
      }).success,
    ).toBe(false);
  });
});
