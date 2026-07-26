import { z } from "zod";

export const nutritionMealCaloriesSchema = z.object({
  breakfast: z.number().nonnegative(),
  lunch: z.number().nonnegative(),
  dinner: z.number().nonnegative(),
  snack: z.number().nonnegative(),
  other: z.number().nonnegative(),
});

export const macroNutritionSummarySchema = z.object({
  grams: z.number().nonnegative(),
  calories: z.number().nonnegative(),
  percentage: z.number().nonnegative(),
});

export const selectedDateNutritionSummarySchema = z.object({
  calories: z.number().nonnegative(),
  mealCalories: nutritionMealCaloriesSchema,
  calorieGoal: z.object({
    target: z.number().positive(),
    remaining: z.number().nonnegative(),
    over: z.number().nonnegative(),
    progressPercentage: z.number().min(0).max(100),
  }),
  macros: z.object({
    protein: macroNutritionSummarySchema,
    carbs: macroNutritionSummarySchema,
    fat: macroNutritionSummarySchema,
  }),
});

export type MacroNutritionSummary = z.infer<typeof macroNutritionSummarySchema>;
export type SelectedDateNutritionSummary = z.infer<typeof selectedDateNutritionSummarySchema>;
