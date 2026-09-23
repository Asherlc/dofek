import type {
  NutritionSourceResolution,
  SelectedDateNutritionSummary,
} from "@dofek/nutrition/selected-date-summary";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  DailyNutritionSummary,
  DailyTotals,
  dailyNutritionSummaryRowSchema,
  dailyTotalsRowSchema,
  FoodEntry,
  FoodSearchResult,
  foodEntryRowSchema,
  foodSearchRowSchema,
  type HealthKitWriteBackFoodEntryRow,
  healthKitWriteBackFoodEntryRowSchema,
} from "./food-entry-models.ts";
import {
  nutritionSourceResolution,
  type SelectedDateNutritionTotalsRow,
  selectedDateNutritionSummary,
  selectedDateNutritionTotalsRowSchema,
} from "./nutrition-source-resolution.ts";

const DOFEK_PROVIDER_ID = "dofek";

/** Read-only data access for food entries, nutrition summaries, and daily totals. */
export class FoodReadRepository {
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
      sql`WITH date_spine AS (
            SELECT generate_series(
              ${startDate}::date,
              ${endDate}::date,
              interval '1 day'
            )::date AS date
          ),
          display_counts AS (
            SELECT display.date, COUNT(display.id)::int AS meal_count
            FROM fitness.v_nutrition_display_entry display
            WHERE display.user_id = ${this.#userId}
              AND display.confirmed = true
              AND display.date >= ${startDate}::date
              AND display.date <= ${endDate}::date
            GROUP BY display.date
          ),
          food_logging AS (
            SELECT entry.date, COUNT(entry.id)::int AS record_count
            FROM fitness.food_entry entry
            WHERE entry.user_id = ${this.#userId}
              AND entry.confirmed = true
              AND entry.date >= ${startDate}::date
              AND entry.date <= ${endDate}::date
            GROUP BY entry.date
          )
          SELECT
            date_spine.date,
            daily.calories,
            daily.protein_g::numeric(10,1) AS protein_g,
            daily.carbs_g::numeric(10,1) AS carbs_g,
            daily.fat_g::numeric(10,1) AS fat_g,
            daily.fiber_g::numeric(10,1) AS fiber_g,
            COALESCE(display_counts.meal_count, 0)::int AS meal_count,
            CASE
              WHEN food_logging.record_count IS NULL THEN 'no_logging'
              ELSE 'unknown_completeness'
            END AS logging_completeness,
            CASE
              WHEN food_logging.record_count IS NULL THEN 'No food or nutrition records were logged for this date.'
              ELSE 'Nutrition was logged, but no source explicitly reported whether the day was complete.'
            END AS logging_completeness_reason,
            COALESCE(daily.source_providers, ARRAY[]::text[]) AS source_providers,
            COALESCE(daily.resolution_status, 'available') AS resolution_status,
            COALESCE(
              daily.resolution_message,
              'No nutrition sources contributed records for this date.'
            ) AS resolution_message,
            COALESCE(daily.contributing_providers, ARRAY[]::text[]) AS contributing_providers,
            COALESCE(daily.excluded_providers, ARRAY[]::text[]) AS excluded_providers,
            COALESCE(daily.source_labels, ARRAY[]::text[]) AS source_labels,
            COALESCE(daily.contributing_source_labels, ARRAY[]::text[])
              AS contributing_source_labels,
            COALESCE(daily.excluded_source_labels, ARRAY[]::text[]) AS excluded_source_labels
          FROM date_spine
          LEFT JOIN fitness.v_nutrition_daily daily
            ON daily.user_id = ${this.#userId}
              AND daily.date = date_spine.date
          LEFT JOIN display_counts ON display_counts.date = date_spine.date
          LEFT JOIN food_logging ON food_logging.date = date_spine.date
          ORDER BY date_spine.date ASC`,
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
      sql`SELECT entry.id, entry.date, entry.food_name,
            MAX(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer AS calories,
            MAX(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein') AS protein_g,
            MAX(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate') AS carbs_g,
            MAX(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat') AS fat_g
          FROM fitness.food_entry AS entry
          LEFT JOIN fitness.food_entry_nutrient AS nutrient ON nutrient.food_entry_id = entry.id
          WHERE entry.user_id = ${this.#userId}
            AND entry.provider_id = ${DOFEK_PROVIDER_ID}
            AND entry.confirmed = true
            AND entry.date >= ${startDate}::date
            AND entry.date <= ${endDate}::date
          GROUP BY entry.id
          ORDER BY entry.date ASC, entry.food_name ASC, entry.id ASC`,
    );
  }
}
