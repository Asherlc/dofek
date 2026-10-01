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
  meals: z.array(
    z.object({
      meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]),
      calories: nonnegativeNumber,
      share_percentage: z.number().finite().min(0).max(100),
    }),
  ),
  macros: z.object({
    protein: macroPreviewSchema,
    carbs: macroPreviewSchema,
    fat: macroPreviewSchema,
  }),
});

export type DayNutritionPreview = z.infer<typeof dayNutritionPreviewSchema>;
