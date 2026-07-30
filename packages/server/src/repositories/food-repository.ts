import type {
  NutritionSourceResolution,
  SelectedDateNutritionSummary,
} from "@dofek/nutrition/selected-date-summary";
import type { Database } from "dofek/db";
import {
  nullableNutrientAmountEntriesFromLegacyFields,
  nutrientAmountEntriesFromLegacyFields,
} from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { summarizeMacros } from "./macro-nutrition-summary.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOFEK_PROVIDER_ID = "dofek";

/** Map of camelCase field names to SQL column names (food_entry-specific) */
const fieldColumnMap: Record<string, string> = {
  date: "date",
  meal: "meal",
  foodName: "food_name",
  foodDescription: "food_description",
  category: "category",
  numberOfUnits: "number_of_units",
};

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

import { nutrientRowSchema } from "dofek/db/nutrient-columns";

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

const dailyTotalsRowSchema = z.object({
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

const dailyNutritionSummaryRowSchema = dailyTotalsRowSchema.extend({
  meal_count: z.coerce.number(),
  source_providers: z.array(z.string()),
});

const selectedDateNutritionTotalsRowSchema = z.object({
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
  contribution_grain: z.enum(["itemized", "daily_aggregate", "ambiguous"]).nullable(),
  contribution_source_label: z.string().nullable(),
});

const foodSearchRowSchema = z.object({
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

const healthKitWriteBackFoodEntryRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  food_name: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
});

const idRowSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// Domain model row types
// ---------------------------------------------------------------------------

export type FoodEntryRow = z.infer<typeof foodEntryRowSchema>;
export type DailyTotalsRow = z.infer<typeof dailyTotalsRowSchema>;
export type DailyNutritionSummaryRow = z.infer<typeof dailyNutritionSummaryRowSchema>;
export type FoodSearchRow = z.infer<typeof foodSearchRowSchema>;
export type HealthKitWriteBackFoodEntryRow = z.infer<typeof healthKitWriteBackFoodEntryRowSchema>;
type SelectedDateNutritionTotalsRow = z.infer<typeof selectedDateNutritionTotalsRowSchema>;

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

function selectedDateNutritionSummary(
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

function nutritionSourceResolution(
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

// ---------------------------------------------------------------------------
// Input types for repository methods
// ---------------------------------------------------------------------------

export interface CreateFoodEntryInput {
  date: string;
  meal?: string | null;
  foodName: string;
  foodDescription?: string | null;
  category?: string | null;
  numberOfUnits?: number | null;
  nutrients: Record<string, number>;
  calories?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  saturatedFatG?: number | null;
  polyunsaturatedFatG?: number | null;
  monounsaturatedFatG?: number | null;
  transFatG?: number | null;
  cholesterolMg?: number | null;
  sodiumMg?: number | null;
  potassiumMg?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  vitaminAMcg?: number | null;
  vitaminCMg?: number | null;
  vitaminDMcg?: number | null;
  vitaminEMg?: number | null;
  vitaminKMcg?: number | null;
  vitaminB1Mg?: number | null;
  vitaminB2Mg?: number | null;
  vitaminB3Mg?: number | null;
  vitaminB5Mg?: number | null;
  vitaminB6Mg?: number | null;
  vitaminB7Mcg?: number | null;
  vitaminB9Mcg?: number | null;
  vitaminB12Mcg?: number | null;
  calciumMg?: number | null;
  ironMg?: number | null;
  magnesiumMg?: number | null;
  zincMg?: number | null;
  seleniumMcg?: number | null;
  copperMg?: number | null;
  manganeseMg?: number | null;
  chromiumMcg?: number | null;
  iodineMcg?: number | null;
  omega3Mg?: number | null;
  omega6Mg?: number | null;
  caffeineMg?: number | null;
}

export interface UpdateFoodEntryInput {
  id: string;
  nutrients?: Record<string, number>;
  [key: string]: unknown;
}

export interface QuickAddInput {
  date: string;
  meal: string;
  foodName: string;
  calories: number;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
}

function nutrientValuesFromInput(
  legacySource: Record<string, unknown>,
  explicitNutrients: Record<string, number> = {},
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const entry of nutrientAmountEntriesFromLegacyFields(legacySource)) {
    values[entry.nutrientId] = entry.amount;
  }
  for (const [nutrientId, amount] of Object.entries(explicitNutrients)) {
    values[nutrientId] = amount;
  }
  return values;
}

async function replaceFoodEntryNutrients(
  db: Pick<Database, "execute">,
  foodEntryId: string,
  userId: string,
  nutrientValues: Record<string, number>,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM fitness.food_entry_nutrient
        WHERE food_entry_id = ${foodEntryId}::uuid
          AND EXISTS (
            SELECT 1
            FROM fitness.food_entry
            WHERE id = ${foodEntryId}::uuid
              AND user_id = ${userId}
              AND confirmed = true
          )`,
  );
  const nutrientEntries = Object.entries(nutrientValues);
  if (nutrientEntries.length === 0) return;
  const valuesClauses = nutrientEntries.map(
    ([nutrientId, amount]) => sql`(${nutrientId}::text, ${amount}::real)`,
  );
  await db.execute(
    sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        SELECT owned_food_entry.id, nutrient_values.nutrient_id, nutrient_values.amount
        FROM (
          SELECT id
          FROM fitness.food_entry
          WHERE id = ${foodEntryId}::uuid
            AND user_id = ${userId}
            AND confirmed = true
        ) owned_food_entry
        CROSS JOIN (VALUES ${sql.join(valuesClauses, sql`, `)}) AS nutrient_values(nutrient_id, amount)`,
  );
}

async function applyLegacyNutrientUpdates(
  db: Pick<Database, "execute">,
  foodEntryId: string,
  userId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const entries = nullableNutrientAmountEntriesFromLegacyFields(updates);
  if (entries.length === 0) return;
  const deleteEntries = entries.filter((entry) => entry.amount === null);
  if (deleteEntries.length > 0) {
    await db.execute(
      sql`DELETE FROM fitness.food_entry_nutrient
          WHERE food_entry_id = ${foodEntryId}::uuid
            AND nutrient_id IN (${sql.join(
              deleteEntries.map((entry) => sql`${entry.nutrientId}`),
              sql`, `,
            )})
            AND EXISTS (
              SELECT 1
              FROM fitness.food_entry
              WHERE id = ${foodEntryId}::uuid
                AND user_id = ${userId}
                AND confirmed = true
            )`,
    );
  }
  const upsertEntries = entries.filter(
    (entry): entry is { nutrientId: string; amount: number } => entry.amount !== null,
  );
  if (upsertEntries.length === 0) return;
  const valuesClauses = upsertEntries.map(
    (entry) => sql`(${entry.nutrientId}::text, ${entry.amount}::real)`,
  );
  await db.execute(
    sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
        SELECT owned_food_entry.id, nutrient_values.nutrient_id, nutrient_values.amount
        FROM (
          SELECT id
          FROM fitness.food_entry
          WHERE id = ${foodEntryId}::uuid
            AND user_id = ${userId}
            AND confirmed = true
        ) owned_food_entry
        CROSS JOIN (VALUES ${sql.join(valuesClauses, sql`, `)}) AS nutrient_values(nutrient_id, amount)
        ON CONFLICT (food_entry_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount`,
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for food entries, nutrition data, and daily totals. */
export class FoodRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** List food entries for a date range, optionally filtered by meal. */
  async list(startDate: string, endDate: string, meal?: string): Promise<FoodEntry[]> {
    if (meal) {
      const rows = await executeWithSchema(
        this.#db,
        foodEntryRowSchema,
        sql`SELECT * FROM fitness.v_nutrition_display_entry
            WHERE user_id = ${this.#userId}
              AND confirmed = true
              AND date >= ${startDate}::date
              AND date <= ${endDate}::date
              AND meal = ${meal}
            ORDER BY date ASC, meal ASC, food_name ASC`,
      );
      return rows.map((row) => new FoodEntry(row));
    }
    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_nutrition_display_entry
          WHERE user_id = ${this.#userId}
            AND confirmed = true
            AND date >= ${startDate}::date
            AND date <= ${endDate}::date
          ORDER BY date ASC, meal ASC, food_name ASC`,
    );
    return rows.map((row) => new FoodEntry(row));
  }

  /** Get all food entries for a specific date, ordered by meal. */
  async byDate(date: string): Promise<FoodEntry[]> {
    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_nutrition_display_entry
          WHERE user_id = ${this.#userId}
            AND confirmed = true
            AND date = ${date}::date
          ORDER BY meal ASC, food_name ASC`,
    );
    return rows.map((row) => new FoodEntry(row));
  }

  /** Canonical totals and source resolution for one selected date. */
  async nutritionByDate(
    date: string,
    calorieGoal: number,
  ): Promise<{
    summary: SelectedDateNutritionSummary | null;
    resolution: NutritionSourceResolution;
  }> {
    const rows = await executeWithSchema(
      this.#db,
      selectedDateNutritionTotalsRowSchema,
      sql`WITH meal_totals AS (
            SELECT
              COALESCE(nutrient.meal, 'other') AS meal,
              COALESCE(SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories'), 0)
                AS calories
            FROM fitness.v_nutrition_canonical_nutrient nutrient
            WHERE nutrient.user_id = ${this.#userId}
              AND nutrient.date = ${date}::date
            GROUP BY COALESCE(nutrient.meal, 'other')
          ),
          meals AS (
            SELECT
              COALESCE(SUM(calories) FILTER (WHERE meal = 'breakfast'), 0) AS breakfast_calories,
              COALESCE(SUM(calories) FILTER (WHERE meal = 'lunch'), 0) AS lunch_calories,
              COALESCE(SUM(calories) FILTER (WHERE meal = 'dinner'), 0) AS dinner_calories,
              COALESCE(SUM(calories) FILTER (WHERE meal = 'snack'), 0) AS snack_calories,
              COALESCE(SUM(calories) FILTER (WHERE meal = 'other'), 0) AS other_calories
            FROM meal_totals
          )
          SELECT
            daily.calories,
            daily.protein_g,
            daily.carbs_g,
            daily.fat_g,
            meals.*,
            daily.resolution_status,
            daily.resolution_message,
            daily.source_providers,
            daily.contributing_providers,
            daily.excluded_providers,
            daily.source_labels,
            daily.contributing_source_labels,
            daily.excluded_source_labels,
            daily.contribution_grain,
            daily.contribution_source_label
          FROM fitness.v_nutrition_daily daily
          CROSS JOIN meals
          WHERE daily.user_id = ${this.#userId}
            AND daily.date = ${date}::date`,
    );
    const row = rows[0];
    if (!row) {
      const emptyRow: SelectedDateNutritionTotalsRow = {
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 0,
        resolution_status: "available",
        resolution_message: "No nutrition sources have reported data for this date.",
        source_providers: [],
        contributing_providers: [],
        excluded_providers: [],
        source_labels: [],
        contributing_source_labels: [],
        excluded_source_labels: [],
        contribution_grain: null,
        contribution_source_label: null,
      };
      return {
        summary: selectedDateNutritionSummary(emptyRow, calorieGoal),
        resolution: nutritionSourceResolution(emptyRow),
      };
    }
    return {
      summary:
        row.resolution_status === "available"
          ? selectedDateNutritionSummary(row, calorieGoal)
          : null,
      resolution: nutritionSourceResolution(row),
    };
  }

  /** Canonical display summary for one selected date. */
  async nutritionSummaryByDate(
    date: string,
    calorieGoal: number,
  ): Promise<SelectedDateNutritionSummary | null> {
    return (await this.nutritionByDate(date, calorieGoal)).summary;
  }

  /** Get daily calorie/macro totals aggregated by day. */
  async dailyTotals(days: number): Promise<DailyTotals[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyTotalsRowSchema,
      sql`SELECT
            date,
            calories,
            protein_g::numeric(10,1) as protein_g,
            carbs_g::numeric(10,1) as carbs_g,
            fat_g::numeric(10,1) as fat_g,
            fiber_g::numeric(10,1) as fiber_g,
            resolution_status,
            resolution_message,
            source_providers,
            contributing_providers,
            excluded_providers,
            source_labels,
            contributing_source_labels,
            excluded_source_labels
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${this.#userId}
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );
    return rows.map((row) => new DailyTotals(row));
  }

  /** Daily nutrition totals inside an exact inclusive date range. */
  async dailyTotalsRange(startDate: string, endDate: string): Promise<DailyNutritionSummary[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyNutritionSummaryRowSchema,
      sql`SELECT
            daily.date,
            daily.calories,
            daily.protein_g::numeric(10,1) AS protein_g,
            daily.carbs_g::numeric(10,1) AS carbs_g,
            daily.fat_g::numeric(10,1) AS fat_g,
            daily.fiber_g::numeric(10,1) AS fiber_g,
            COUNT(display.id)::int AS meal_count,
            daily.source_providers,
            daily.resolution_status,
            daily.resolution_message,
            daily.contributing_providers,
            daily.excluded_providers,
            daily.source_labels,
            daily.contributing_source_labels,
            daily.excluded_source_labels
          FROM fitness.v_nutrition_daily daily
          LEFT JOIN fitness.v_nutrition_display_entry display
            ON display.user_id = daily.user_id
              AND display.date = daily.date
              AND display.confirmed = true
          WHERE daily.user_id = ${this.#userId}
            AND daily.date >= ${startDate}::date
            AND daily.date <= ${endDate}::date
          GROUP BY daily.date, daily.user_id, daily.calories, daily.protein_g, daily.carbs_g,
                   daily.fat_g, daily.fiber_g, daily.source_providers,
                   daily.resolution_status, daily.resolution_message,
                   daily.contributing_providers, daily.excluded_providers,
                   daily.source_labels, daily.contributing_source_labels,
                   daily.excluded_source_labels
          ORDER BY daily.date ASC`,
    );
    return rows.map((row) => new DailyNutritionSummary(row));
  }

  /** Search food entries by name for quick re-logging. */
  async search(query: string, limit: number): Promise<FoodSearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await executeWithSchema(
      this.#db,
      foodSearchRowSchema,
      sql`SELECT DISTINCT ON (fe.food_name)
            fe.food_name, fe.food_description, fe.category,
            fe.calories, fe.protein_g, fe.carbs_g, fe.fat_g, fe.fiber_g,
            fe.number_of_units
          FROM fitness.v_nutrition_display_entry fe
          WHERE fe.user_id = ${this.#userId}
            AND fe.confirmed = true
            AND fe.food_name IS NOT NULL
            AND fe.food_name ILIKE ${searchPattern}
          ORDER BY fe.food_name ASC
          LIMIT ${limit}`,
    );
    return rows.map((row) => new FoodSearchResult(row));
  }

  /** Direct Dofek food entries that mobile can write back to Apple Health. */
  async healthKitWriteBackEntries(
    startDate: string,
    endDate: string,
  ): Promise<HealthKitWriteBackFoodEntryRow[]> {
    return executeWithSchema(
      this.#db,
      healthKitWriteBackFoodEntryRowSchema,
      sql`SELECT id, date, food_name, calories, protein_g, carbs_g, fat_g
          FROM fitness.v_food_entry_with_nutrition
          WHERE user_id = ${this.#userId}
            AND provider_id = ${DOFEK_PROVIDER_ID}
            AND confirmed = true
            AND date >= ${startDate}::date
            AND date <= ${endDate}::date
          ORDER BY date ASC, food_name ASC, id ASC`,
    );
  }

  /** Ensure the 'dofek' provider row exists (for self-created entries). */
  async ensureDofekProvider(): Promise<void> {
    await ensurePushProvider({
      database: this.#db,
      providerId: DOFEK_PROVIDER_ID,
      providerName: "Dofek App",
      userId: this.#userId,
    });
  }

  /** Create a new food entry with nutrition data. Returns the created entry row plus nutrients. */
  async create(
    input: CreateFoodEntryInput,
  ): Promise<FoodEntryRow & { nutrients: Record<string, number> }> {
    await this.ensureDofekProvider();
    const nutrientValues = nutrientValuesFromInput({ ...input }, input.nutrients);
    const nutrientValueClauses = Object.entries(nutrientValues).map(
      ([nutrientId, amount]) => sql`(${nutrientId}::text, ${amount}::real)`,
    );

    const idRows = await executeWithSchema(
      this.#db,
      idRowSchema,
      nutrientValueClauses.length > 0
        ? sql`WITH new_entry AS (
          INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description,
            category, number_of_units, nutrition_grain
          ) VALUES (
            ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
            ${input.category ?? null}, ${input.numberOfUnits ?? null}, 'itemized'
          ) RETURNING id
        ),
        new_nutrients AS (
          INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
          SELECT id, nutrient_id, amount
          FROM new_entry
          CROSS JOIN (VALUES ${sql.join(nutrientValueClauses, sql`, `)}) AS vals(nutrient_id, amount)
        )
        SELECT id FROM new_entry`
        : sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description,
            category, number_of_units, nutrition_grain
          ) VALUES (
            ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
            ${input.category ?? null}, ${input.numberOfUnits ?? null}, 'itemized'
          ) RETURNING id`,
    );
    const newId = idRows[0]?.id;
    if (!newId) throw new Error("Failed to insert food entry");

    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${newId}`,
    );
    const inserted = rows[0];
    if (!inserted) throw new Error("Failed to insert food entry");

    return { ...inserted, nutrients: nutrientValues };
  }

  /** Update an existing food entry by id. */
  async update(input: UpdateFoodEntryInput): Promise<FoodEntryRow | null> {
    const { id, nutrients, ...fields } = input;

    // Separate food_entry fields from nutrient fields
    const foodEntryClauses: ReturnType<typeof sql>[] = [];

    for (const [fieldName, value] of Object.entries(fields)) {
      if (value === undefined) continue;

      // Check if it's a food_entry field
      const foodColumn = fieldColumnMap[fieldName];
      if (foodColumn) {
        if (fieldName === "date") {
          foodEntryClauses.push(
            value !== null
              ? sql`${sql.identifier(foodColumn)} = ${String(value)}::date`
              : sql`${sql.identifier(foodColumn)} = NULL`,
          );
        } else if (value === null) {
          foodEntryClauses.push(sql`${sql.identifier(foodColumn)} = NULL`);
        } else {
          foodEntryClauses.push(sql`${sql.identifier(foodColumn)} = ${value}`);
        }
      }
    }

    const nutrientUpdates = nullableNutrientAmountEntriesFromLegacyFields(fields);
    if (foodEntryClauses.length === 0 && nutrientUpdates.length === 0 && !nutrients) return null;

    if (nutrientUpdates.length > 0) {
      await applyLegacyNutrientUpdates(this.#db, id, this.#userId, fields);
    }

    // Update food_entry if any food fields changed
    if (foodEntryClauses.length > 0) {
      const foodSetExpression = sql.join(foodEntryClauses, sql`, `);
      await this.#db.execute(
        sql`UPDATE fitness.food_entry SET ${foodSetExpression} WHERE user_id = ${this.#userId} AND confirmed = true AND id = ${id}`,
      );
    }

    // Replace nutrients in junction table if provided
    if (nutrients) {
      await replaceFoodEntryNutrients(this.#db, id, this.#userId, nutrients);
    }

    // Return the updated row
    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${id} AND user_id = ${this.#userId}`,
    );
    return rows[0] ?? null;
  }

  /** Delete a food entry by id. */
  async delete(id: string): Promise<{ success: boolean }> {
    await this.#db.execute(
      sql`DELETE FROM fitness.food_entry
          WHERE user_id = ${this.#userId} AND confirmed = true AND id = ${id}`,
    );
    return { success: true };
  }

  /** Quick-add a food entry with minimal details. */
  async quickAdd(
    input: QuickAddInput,
  ): Promise<(FoodEntryRow & { nutrients: Record<string, number> }) | undefined> {
    await this.ensureDofekProvider();
    const nutrientValues = nutrientValuesFromInput({ ...input });
    const nutrientValueClauses = Object.entries(nutrientValues).map(
      ([nutrientId, amount]) => sql`(${nutrientId}::text, ${amount}::real)`,
    );

    const idRows = await executeWithSchema(
      this.#db,
      idRowSchema,
      nutrientValueClauses.length > 0
        ? sql`WITH new_entry AS (
          INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, nutrition_grain
          ) VALUES (
            ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal}, ${input.foodName}, 'itemized'
          ) RETURNING id
        ),
        new_nutrients AS (
          INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
          SELECT id, nutrient_id, amount
          FROM new_entry
          CROSS JOIN (VALUES ${sql.join(nutrientValueClauses, sql`, `)}) AS vals(nutrient_id, amount)
        )
        SELECT id FROM new_entry`
        : sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, nutrition_grain
          ) VALUES (
            ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
            ${input.meal}, ${input.foodName}, 'itemized'
          ) RETURNING id`,
    );
    const newId = idRows[0]?.id;
    if (!newId) return undefined;

    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition WHERE id = ${newId}`,
    );
    return rows[0] ? { ...rows[0], nutrients: {} } : undefined;
  }
}
