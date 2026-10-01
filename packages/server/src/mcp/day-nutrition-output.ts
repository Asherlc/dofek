import {
  type DayNutritionPreview,
  dayNutritionPreviewSchema,
} from "@dofek/mcp-contracts/day-nutrition";
import type { SelectedDateNutritionTotals } from "../repositories/nutrition-source-resolution.ts";

export function toDayNutritionPreview(
  date: string,
  summary: SelectedDateNutritionTotals,
): DayNutritionPreview {
  return dayNutritionPreviewSchema.parse({
    date,
    total_calories: summary.calories,
    protein_g: summary.macros.protein.grams,
    carbs_g: summary.macros.carbs.grams,
    fat_g: summary.macros.fat.grams,
    meals: Object.entries(summary.mealCalories).map(([meal, calories]) => ({
      meal,
      calories,
      share_percentage: summary.calories > 0 ? (calories / summary.calories) * 100 : 0,
    })),
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
