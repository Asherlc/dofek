import { z } from "zod";
import type { DailyNutritionSummary } from "../repositories/food-repository.ts";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
export const MAX_NUTRITION_SUMMARY_DAYS = 366;

export function assertNutritionSummaryDateRange(startDate: string, endDate: string): void {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const inclusiveDays = Math.round((end - start) / 86_400_000) + 1;
  if (inclusiveDays > MAX_NUTRITION_SUMMARY_DAYS) {
    throw new Error(
      `Nutrition summaries support at most ${MAX_NUTRITION_SUMMARY_DAYS} inclusive days per request; split longer ranges into chunks`,
    );
  }
}

/** Shared daily nutrition wire contract used by standalone and aligned analytical tools. */
export const nutritionSummaryItemSchema = z.object({
  date: z.string(),
  total_calories: nullableNumber,
  protein_g: nullableNumber,
  carbs_g: nullableNumber,
  fat_g: nullableNumber,
  fiber_g: nullableNumber,
  meal_count: z.number(),
  logging_completeness: z.enum([
    "complete",
    "explicitly_partial",
    "unknown_completeness",
    "no_logging",
  ]),
  logging_completeness_reason: z.string().min(1),
  resolution_status: z.enum(["available", "source_conflict"]),
  resolution_message: z.string(),
  source_provider: nullableString,
  source_providers: z.array(z.string()),
  contributing_providers: z.array(z.string()),
  excluded_providers: z.array(z.string()),
});

export function toNutritionSummaryOutput(row: DailyNutritionSummary) {
  return {
    date: row.date,
    total_calories: row.calories,
    protein_g: row.proteinGrams,
    carbs_g: row.carbsGrams,
    fat_g: row.fatGrams,
    fiber_g: row.fiberGrams,
    meal_count: row.mealCount,
    logging_completeness: row.loggingCompleteness,
    logging_completeness_reason: row.loggingCompletenessReason,
    resolution_status: row.resolutionStatus,
    resolution_message: row.resolutionMessage,
    source_provider: row.contributingProviders.length === 1 ? row.contributingProviders[0] : null,
    source_providers: row.sourceProviders,
    contributing_providers: row.contributingProviders,
    excluded_providers: row.excludedProviders,
  };
}
