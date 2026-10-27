import { nutrientRowSchema } from "dofek/db/nutrient-columns";
import { z } from "zod";
import { timestampStringSchema } from "../lib/typed-sql.ts";

const nullableStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const nullableTimestampStringSchema = timestampStringSchema
  .nullish()
  .transform((value) => value ?? null);

export const foodEntryRowSchema = z
  .object({
    id: z.string(),
    provider_id: z.string(),
    user_id: z.string(),
    external_id: z.string().nullable(),
    date: z.string(),
    meal: z.string().nullable(),
    food_name: z.string().nullable(),
    food_description: z.string().nullable(),
    category: z.string().nullable(),
    provider_food_id: z.string().nullable(),
    provider_serving_id: z.string().nullable(),
    number_of_units: z.coerce.number().nullable(),
    logged_at: timestampStringSchema.nullable(),
    source_name: nullableStringSchema,
    started_at: nullableTimestampStringSchema,
    ended_at: nullableTimestampStringSchema,
    barcode: z.string().nullable(),
    serving_unit: z.string().nullable(),
    serving_weight_grams: z.coerce.number().nullable(),
    nutrition_data_id: z.string().nullable(),
    raw: z.unknown().nullable(),
    confirmed: z.boolean(),
    created_at: timestampStringSchema,
  })
  .merge(nutrientRowSchema);

export const dailyTotalsRowSchema = z.object({
  date: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  resolution_status: z.enum(["available", "source_conflict"]),
  resolution_message: z.string(),
  source_providers: z.array(z.string()),
  contributing_providers: z.array(z.string()),
  excluded_providers: z.array(z.string()),
  source_labels: z.array(z.string()),
  contributing_source_labels: z.array(z.string()),
  excluded_source_labels: z.array(z.string()),
});

export const dailyNutritionSummaryRowSchema = dailyTotalsRowSchema.extend({
  meal_count: z.coerce.number(),
  logging_completeness: z.enum([
    "complete",
    "explicitly_partial",
    "unknown_completeness",
    "no_logging",
  ]),
  logging_completeness_reason: z.string(),
  source_providers: z.array(z.string()),
});

export const foodSearchRowSchema = z.object({
  food_name: z.string(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  number_of_units: z.coerce.number().nullable(),
});

export const healthKitWriteBackFoodEntryRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  food_name: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
});

export type FoodEntryRow = z.infer<typeof foodEntryRowSchema>;
export type DailyTotalsRow = z.infer<typeof dailyTotalsRowSchema>;
export type DailyNutritionSummaryRow = z.infer<typeof dailyNutritionSummaryRowSchema>;
export type FoodSearchRow = z.infer<typeof foodSearchRowSchema>;
export type HealthKitWriteBackFoodEntryRow = z.infer<typeof healthKitWriteBackFoodEntryRowSchema>;

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

/** A food entry with full nutrition data from the v_food_entry_with_nutrition view. */
export class FoodEntry {
  readonly #row: FoodEntryRow;

  constructor(row: FoodEntryRow) {
    this.#row = row;
  }

  get id(): string {
    return this.#row.id;
  }

  get date(): string {
    return this.#row.date;
  }

  get meal(): string | null {
    return this.#row.meal;
  }

  get foodName(): string | null {
    return this.#row.food_name;
  }

  get providerId(): string {
    return this.#row.provider_id;
  }

  get confirmed(): boolean {
    return this.#row.confirmed;
  }

  get nutritionDataId(): string | null {
    return this.#row.nutrition_data_id;
  }

  toDetail(): FoodEntryRow {
    return { ...this.#row };
  }
}

/** Daily macro totals. */
export class DailyTotals {
  readonly #row: DailyTotalsRow;

  constructor(row: DailyTotalsRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get calories(): number | null {
    return this.#row.calories;
  }

  toDetail(): DailyTotalsRow {
    return { ...this.#row };
  }
}

export class DailyNutritionSummary {
  readonly #row: DailyNutritionSummaryRow;

  constructor(row: DailyNutritionSummaryRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get calories(): number | null {
    return this.#row.calories;
  }

  get proteinGrams(): number | null {
    return this.#row.protein_g;
  }

  get carbsGrams(): number | null {
    return this.#row.carbs_g;
  }

  get fatGrams(): number | null {
    return this.#row.fat_g;
  }

  get fiberGrams(): number | null {
    return this.#row.fiber_g;
  }

  get mealCount(): number {
    return this.#row.meal_count;
  }

  get loggingCompleteness():
    | "complete"
    | "explicitly_partial"
    | "unknown_completeness"
    | "no_logging" {
    return this.#row.logging_completeness;
  }

  get loggingCompletenessReason(): string {
    return this.#row.logging_completeness_reason;
  }

  get sourceProviders(): string[] {
    return this.#row.source_providers;
  }

  get resolutionStatus(): "available" | "source_conflict" {
    return this.#row.resolution_status;
  }

  get resolutionMessage(): string {
    return this.#row.resolution_message;
  }

  get contributingProviders(): string[] {
    return this.#row.contributing_providers;
  }

  get excludedProviders(): string[] {
    return this.#row.excluded_providers;
  }
}

/** A food search result for quick re-logging. */
export class FoodSearchResult {
  readonly #row: FoodSearchRow;

  constructor(row: FoodSearchRow) {
    this.#row = row;
  }

  get foodName(): string {
    return this.#row.food_name;
  }

  toDetail(): FoodSearchRow {
    return { ...this.#row };
  }
}
