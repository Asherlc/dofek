import { describe, expect, it } from "vitest";
import { selectedDateNutritionSummarySchema } from "./selected-date-summary.ts";

const summary = {
  calories: 1000,
  mealCalories: {
    breakfast: 400,
    lunch: 500,
    dinner: 0,
    snack: 0,
    other: 100,
  },
  calorieGoal: {
    target: 1600,
    remaining: 600,
    over: 0,
    progressPercentage: 62.5,
  },
  macros: {
    protein: { grams: 55, calories: 220, percentage: 22 },
    carbs: { grams: 105, calories: 420, percentage: 42 },
    fat: { grams: 40, calories: 360, percentage: 36 },
  },
};

describe("selectedDateNutritionSummarySchema", () => {
  it("parses the canonical selected-date display summary", () => {
    expect(selectedDateNutritionSummarySchema.parse(summary)).toEqual(summary);
  });

  it("rejects a goal progress percentage above the display maximum", () => {
    expect(() =>
      selectedDateNutritionSummarySchema.parse({
        ...summary,
        calorieGoal: { ...summary.calorieGoal, progressPercentage: 101 },
      }),
    ).toThrow();
  });
});
