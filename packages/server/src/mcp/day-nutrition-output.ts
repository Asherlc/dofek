import {
  type DayNutritionPreview,
  dayNutritionPreviewSchema,
} from "@dofek/mcp-contracts/day-nutrition";
import type {
  NutritionCalorieTargetType,
  SelectedDateNutritionSummary,
} from "@dofek/nutrition/selected-date-summary";

export function toDayNutritionPreview(
  date: string,
  summary: SelectedDateNutritionSummary,
  calorieGoalType: NutritionCalorieTargetType,
): DayNutritionPreview {
  return dayNutritionPreviewSchema.parse({
    date,
    total_calories: summary.calories,
    protein_g: summary.macros.protein.grams,
    carbs_g: summary.macros.carbs.grams,
    fat_g: summary.macros.fat.grams,
    calorie_goal: {
      target: summary.calorieGoal.target,
      remaining: summary.calorieGoal.remaining,
      over: summary.calorieGoal.over,
      progress_percentage: summary.calorieGoal.progressPercentage,
      type: calorieGoalType,
    },
    macros: {
      protein: {
        grams: summary.macros.protein.grams,
        energy_share_percentage: summary.macros.protein.energySharePercentage,
      },
      carbs: {
        grams: summary.macros.carbs.grams,
        energy_share_percentage: summary.macros.carbs.energySharePercentage,
      },
      fat: {
        grams: summary.macros.fat.grams,
        energy_share_percentage: summary.macros.fat.energySharePercentage,
      },
    },
  });
}
