import { describe, expect, it } from "vitest";
import { toDayNutritionPreview } from "./day-nutrition-output.ts";

describe("toDayNutritionPreview", () => {
  it("maps selected-date nutrition summary into the compact MCP preview", () => {
    expect(
      toDayNutritionPreview("2026-09-07", {
        calories: 1450,
        mealCalories: {
          breakfast: 400,
          lunch: 500,
          dinner: 450,
          snack: 100,
          other: 0,
        },
        macros: {
          protein: { grams: 98, calories: 392, energySharePercentage: 28 },
          carbs: { grams: 120, calories: 480, energySharePercentage: 34 },
          fat: { grams: 55, calories: 495, energySharePercentage: 38 },
        },
      }),
    ).toEqual({
      date: "2026-09-07",
      total_calories: 1450,
      protein_g: 98,
      carbs_g: 120,
      fat_g: 55,
      meals: [
        { meal: "breakfast", calories: 400, share_percentage: (400 / 1450) * 100 },
        { meal: "lunch", calories: 500, share_percentage: (500 / 1450) * 100 },
        { meal: "dinner", calories: 450, share_percentage: (450 / 1450) * 100 },
        { meal: "snack", calories: 100, share_percentage: (100 / 1450) * 100 },
        { meal: "other", calories: 0, share_percentage: 0 },
      ],
      macros: {
        protein: { grams: 98, energy_share_percentage: 28 },
        carbs: { grams: 120, energy_share_percentage: 34 },
        fat: { grams: 55, energy_share_percentage: 38 },
      },
    });
  });
});

it("returns zero meal shares for an empty date", () => {
  const result = toDayNutritionPreview("2026-09-07", {
    calories: 0,
    mealCalories: { breakfast: 0, lunch: 0, dinner: 0, snack: 0, other: 0 },
    macros: {
      protein: { grams: 0, calories: 0, energySharePercentage: 0 },
      carbs: { grams: 0, calories: 0, energySharePercentage: 0 },
      fat: { grams: 0, calories: 0, energySharePercentage: 0 },
    },
  });
  expect(result.meals).toEqual(
    ["breakfast", "lunch", "dinner", "snack", "other"].map((meal) => ({
      meal,
      calories: 0,
      share_percentage: 0,
    })),
  );
});

it.each([
  { calories: 300, breakfast: 300.25, lunch: 0, breakfastShare: 100, lunchShare: 0 },
  { calories: 0, breakfast: 0.25, lunch: 0, breakfastShare: 100, lunchShare: 0 },
  {
    calories: 301,
    breakfast: 100.25,
    lunch: 200.25,
    breakfastShare: (100.25 / 300.5) * 100,
    lunchShare: (200.25 / 300.5) * 100,
  },
])(
  "uses precise meal totals for shares when the daily total rounds to $calories",
  ({ calories, breakfast, lunch, breakfastShare, lunchShare }) => {
    const preview = toDayNutritionPreview("2026-09-07", {
      calories,
      mealCalories: { breakfast, lunch, dinner: 0, snack: 0, other: 0 },
      macros: {
        protein: { grams: 0, calories: 0, energySharePercentage: 0 },
        carbs: { grams: 0, calories: 0, energySharePercentage: 0 },
        fat: { grams: 0, calories: 0, energySharePercentage: 0 },
      },
    });
    expect(preview.meals[0]?.share_percentage).toBe(breakfastShare);
    expect(preview.meals[1]?.share_percentage).toBe(lunchShare);
    expect(preview.meals.reduce((sum, meal) => sum + meal.share_percentage, 0)).toBeCloseTo(100);
  },
);
