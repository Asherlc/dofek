import { describe, expect, it } from "vitest";
import { toDayNutritionPreview } from "./day-nutrition-output.ts";

describe("toDayNutritionPreview", () => {
  it("maps selected-date nutrition summary into the compact MCP preview", () => {
    expect(
      toDayNutritionPreview(
        "2026-09-07",
        {
          calories: 1450,
          mealCalories: {
            breakfast: 400,
            lunch: 500,
            dinner: 450,
            snack: 100,
            other: 0,
          },
          calorieGoal: {
            target: 2200,
            remaining: 750,
            over: 0,
            progressPercentage: 65.9,
          },
          macros: {
            protein: { grams: 98, calories: 392, energySharePercentage: 28 },
            carbs: { grams: 120, calories: 480, energySharePercentage: 34 },
            fat: { grams: 55, calories: 495, energySharePercentage: 38 },
          },
        },
        "configured",
      ),
    ).toEqual({
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
        type: "configured",
      },
      macros: {
        protein: { grams: 98, energy_share_percentage: 28 },
        carbs: { grams: 120, energy_share_percentage: 34 },
        fat: { grams: 55, energy_share_percentage: 38 },
      },
    });
  });
});
