import type {
  NutritionSourceResolution,
  SelectedDateNutritionSummary,
} from "@dofek/nutrition/selected-date-summary";
import { z } from "zod";
import { summarizeMacros } from "./macro-nutrition-summary.ts";

export const selectedDateNutritionTotalsRowSchema = z.object({
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  breakfast_calories: z.coerce.number(),
  lunch_calories: z.coerce.number(),
  dinner_calories: z.coerce.number(),
  snack_calories: z.coerce.number(),
  other_calories: z.coerce.number(),
  resolution_status: z.enum(["available", "source_conflict"]),
  resolution_message: z.string(),
  source_providers: z.array(z.string()),
  contributing_providers: z.array(z.string()),
  excluded_providers: z.array(z.string()),
  source_labels: z.array(z.string()),
  contributing_source_labels: z.array(z.string()),
  excluded_source_labels: z.array(z.string()),
  contribution_grain: z
    .enum(["itemized", "meal_aggregate", "daily_aggregate", "ambiguous"])
    .nullable(),
  contribution_source_label: z.string().nullable(),
});

export type SelectedDateNutritionTotalsRow = z.infer<typeof selectedDateNutritionTotalsRowSchema>;

export function selectedDateNutritionSummary(
  row: SelectedDateNutritionTotalsRow,
  calorieGoal: number,
): SelectedDateNutritionSummary {
  const calories = row.calories ?? 0;
  const remaining = Math.max(calorieGoal - calories, 0);
  const over = Math.max(calories - calorieGoal, 0);
  return {
    calories,
    mealCalories: {
      breakfast: row.breakfast_calories,
      lunch: row.lunch_calories,
      dinner: row.dinner_calories,
      snack: row.snack_calories,
      other: row.other_calories,
    },
    calorieGoal: {
      target: calorieGoal,
      remaining,
      over,
      progressPercentage: Math.min((calories / calorieGoal) * 100, 100),
    },
    macros: summarizeMacros(row.protein_g ?? 0, row.carbs_g ?? 0, row.fat_g ?? 0),
  };
}

export function nutritionSourceResolution(
  row: Pick<
    SelectedDateNutritionTotalsRow,
    | "resolution_status"
    | "resolution_message"
    | "source_providers"
    | "contributing_providers"
    | "excluded_providers"
    | "source_labels"
    | "contributing_source_labels"
    | "excluded_source_labels"
    | "contribution_grain"
    | "contribution_source_label"
  >,
): NutritionSourceResolution {
  const contributionLabel =
    row.contribution_source_label && row.contribution_grain
      ? `${row.contribution_source_label} ${
          row.contribution_grain === "daily_aggregate"
            ? "daily total"
            : row.contribution_grain === "meal_aggregate"
              ? "meal totals"
              : row.contribution_grain === "itemized"
                ? "itemized entries"
                : "nutrition data"
        }`
      : null;
  return {
    status: row.resolution_status,
    message: row.resolution_message,
    sourceProviders: row.source_providers,
    contributingProviders: row.contributing_providers,
    excludedProviders: row.excluded_providers,
    sourceLabels: row.source_labels,
    contributingSourceLabels: row.contributing_source_labels,
    excludedSourceLabels: row.excluded_source_labels,
    contributionGrain: row.contribution_grain,
    contributionLabel,
  };
}
