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
  energySharePercentage: z.number().int().min(0).max(100),
});

export const selectedDateNutritionSummarySchema = z
  .object({
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
  })
  .superRefine(({ macros }, context) => {
    const totalMacroCalories =
      macros.protein.calories + macros.carbs.calories + macros.fat.calories;
    const totalEnergySharePercentage =
      macros.protein.energySharePercentage +
      macros.carbs.energySharePercentage +
      macros.fat.energySharePercentage;
    const expectedEnergySharePercentage = totalMacroCalories > 0 ? 100 : 0;

    if (totalEnergySharePercentage !== expectedEnergySharePercentage) {
      context.addIssue({
        code: "custom",
        message: `Macro energy shares must total ${expectedEnergySharePercentage} percent`,
        path: ["macros"],
      });
    }
  });

export const nutritionSourceResolutionSchema = z.object({
  status: z.enum(["available", "source_conflict"]),
  message: z.string().min(1),
  sourceProviders: z.array(z.string()),
  contributingProviders: z.array(z.string()),
  excludedProviders: z.array(z.string()),
  sourceLabels: z.array(z.string()),
  contributingSourceLabels: z.array(z.string()),
  excludedSourceLabels: z.array(z.string()),
  contributionGrain: z.enum(["itemized", "daily_aggregate", "ambiguous"]).nullable(),
  contributionLabel: z.string().min(1).nullable(),
});

export type MacroNutritionSummary = z.infer<typeof macroNutritionSummarySchema>;
export type SelectedDateNutritionSummary = z.infer<typeof selectedDateNutritionSummarySchema>;

export const nutritionCalorieTargetTypeSchema = z.enum(["configured", "default"]);

export const selectedDateNutritionIntakeContextSchema = z.object({
  observedCalories: z.number().nonnegative(),
  target: z.object({
    calories: z.number().positive(),
    type: nutritionCalorieTargetTypeSchema,
    label: z.string().min(1),
  }),
  scale: z.object({
    maximumCalories: z.number().positive(),
    observedPercentage: z.number().min(0).max(100),
    targetPercentage: z.number().min(0).max(100),
  }),
  comparison: z.object({
    status: z.enum(["below_target", "at_target", "above_target"]),
    differenceCalories: z.number().nonnegative(),
    message: z.string().min(1),
  }),
  limitation: z.string().min(1),
});

export type NutritionCalorieTargetType = z.infer<typeof nutritionCalorieTargetTypeSchema>;
export type SelectedDateNutritionIntakeContext = z.infer<
  typeof selectedDateNutritionIntakeContextSchema
>;
export type NutritionSourceResolution = z.infer<typeof nutritionSourceResolutionSchema>;
