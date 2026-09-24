import { z } from "zod";

const dateSchema = z.iso.date();
const nonnegativeNumber = z.number().finite().nonnegative();

const macroPreviewSchema = z.object({
  grams: nonnegativeNumber,
  energy_share_percentage: z.number().int().min(0).max(100),
});

/** Compact post-mutation day preview for MCP food tools and the day-nutrition App. */
export const dayNutritionPreviewSchema = z.object({
  date: dateSchema,
  total_calories: nonnegativeNumber,
  protein_g: nonnegativeNumber,
  carbs_g: nonnegativeNumber,
  fat_g: nonnegativeNumber,
  calorie_goal: z.object({
    target: z.number().positive(),
    remaining: nonnegativeNumber,
    over: nonnegativeNumber,
    progress_percentage: z.number().min(0).max(100),
    type: z.enum(["configured", "default"]),
  }),
  macros: z.object({
    protein: macroPreviewSchema,
    carbs: macroPreviewSchema,
    fat: macroPreviewSchema,
  }),
});

export type DayNutritionPreview = z.infer<typeof dayNutritionPreviewSchema>;
