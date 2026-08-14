import type { Database } from "dofek/db";
import { nutrientRowSchema } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

export const foodEntryRowSchema = z
  .object({
    id: z.string(),
    provider_id: z.string(),
    user_id: z.string(),
    external_id: z.string().nullable(),
    date: z.string(),
    meal: z.string().nullable(),
    food_name: z.string(),
    food_description: z.string().nullable(),
    category: z.string().nullable(),
    provider_food_id: z.string().nullable(),
    provider_serving_id: z.string().nullable(),
    number_of_units: z.coerce.number().nullable(),
    logged_at: z.string().nullable(),
    barcode: z.string().nullable(),
    serving_unit: z.string().nullable(),
    serving_weight_grams: z.coerce.number().nullable(),
    nutrition_data_id: z.string().nullable(),
    raw: z.unknown().nullable(),
    confirmed: z.boolean(),
    created_at: z.string(),
  })
  .merge(nutrientRowSchema);

const dailyTotalsRowSchema = z.object({
  date: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
});

export type FoodEntryRow = z.infer<typeof foodEntryRowSchema>;
export type DailyTotalsRow = z.infer<typeof dailyTotalsRowSchema>;

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

  get foodName(): string {
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

/** Read-only data access for provider-ingested food entries and daily totals. */
export class FoodRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async list(startDate: string, endDate: string, meal?: string): Promise<FoodEntry[]> {
    if (meal) {
      const rows = await executeWithSchema(
        this.#db,
        foodEntryRowSchema,
        sql`SELECT * FROM fitness.v_food_entry_with_nutrition
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
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition
          WHERE user_id = ${this.#userId}
            AND confirmed = true
            AND date >= ${startDate}::date
            AND date <= ${endDate}::date
          ORDER BY date ASC, meal ASC, food_name ASC`,
    );
    return rows.map((row) => new FoodEntry(row));
  }

  async byDate(date: string): Promise<FoodEntry[]> {
    const rows = await executeWithSchema(
      this.#db,
      foodEntryRowSchema,
      sql`SELECT * FROM fitness.v_food_entry_with_nutrition
          WHERE user_id = ${this.#userId}
            AND confirmed = true
            AND date = ${date}::date
          ORDER BY meal ASC, food_name ASC`,
    );
    return rows.map((row) => new FoodEntry(row));
  }

  async dailyTotals(days: number): Promise<DailyTotals[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyTotalsRowSchema,
      sql`SELECT
            fe.date,
            SUM(nd.calories) as calories,
            SUM(nd.protein_g)::numeric(10,1) as protein_g,
            SUM(nd.carbs_g)::numeric(10,1) as carbs_g,
            SUM(nd.fat_g)::numeric(10,1) as fat_g,
            SUM(nd.fiber_g)::numeric(10,1) as fiber_g
          FROM fitness.food_entry fe
          JOIN fitness.food_entry_nutrition nd ON nd.food_entry_id = fe.id
          WHERE fe.user_id = ${this.#userId}
            AND fe.confirmed = true
            AND fe.date > CURRENT_DATE - ${days}::int
          GROUP BY fe.date
          ORDER BY fe.date ASC`,
    );
    return rows.map((row) => new DailyTotals(row));
  }
}
