import type { Database } from "dofek/db";
import { NUTRIENT_COLUMN_MAP, NUTRIENT_SQL_COLUMNS } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

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

const idRowSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// Domain model row types
// ---------------------------------------------------------------------------

export type FoodEntryRow = z.infer<typeof foodEntryRowSchema>;
export type DailyTotalsRow = z.infer<typeof dailyTotalsRowSchema>;
export type FoodSearchRow = z.infer<typeof foodSearchRowSchema>;

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

  /** Get all food entries for a specific date, ordered by meal. */
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

  /** Get daily calorie/macro totals aggregated by day. */
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

  /** Search food entries by name for quick re-logging. */
  async search(query: string, limit: number): Promise<FoodSearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await executeWithSchema(
      this.#db,
      foodSearchRowSchema,
      sql`SELECT DISTINCT ON (fe.food_name)
            fe.food_name, fe.food_description, fe.category,
            nd.calories, nd.protein_g, nd.carbs_g, nd.fat_g, nd.fiber_g,
            fe.number_of_units
          FROM fitness.food_entry fe
          LEFT JOIN fitness.food_entry_nutrition nd ON nd.food_entry_id = fe.id
          WHERE fe.user_id = ${this.#userId}
            AND fe.confirmed = true
            AND fe.food_name ILIKE ${searchPattern}
          ORDER BY fe.food_name ASC
          LIMIT ${limit}`,
    );
    return rows.map((row) => new FoodSearchResult(row));
  }

  /** Ensure the 'dofek' provider row exists (for self-created entries). */
  async ensureDofekProvider(): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App', ${this.#userId})
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Create a new food entry with nutrition data. Returns the created entry row plus nutrients. */
  async create(
    input: CreateFoodEntryInput,
  ): Promise<FoodEntryRow & { nutrients: Record<string, number> }> {
    await this.ensureDofekProvider();

    const idRows = await executeWithSchema(
      this.#db,
      idRowSchema,
      sql`WITH new_entry AS (
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, food_description,
              category, number_of_units
            ) VALUES (
              ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
              ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
              ${input.category ?? null}, ${input.numberOfUnits ?? null}
            ) RETURNING id
          ),
          new_nutrition AS (
            INSERT INTO fitness.food_entry_nutrition (
              food_entry_id, ${sql.raw(NUTRIENT_SQL_COLUMNS)}
            )
            SELECT id, ${input.calories ?? null}, ${input.proteinG ?? null},
                   ${input.carbsG ?? null}, ${input.fatG ?? null},
                   ${input.saturatedFatG ?? null}, ${input.polyunsaturatedFatG ?? null},
                   ${input.monounsaturatedFatG ?? null}, ${input.transFatG ?? null},
                   ${input.cholesterolMg ?? null}, ${input.sodiumMg ?? null},
                   ${input.potassiumMg ?? null}, ${input.fiberG ?? null}, ${input.sugarG ?? null},
                   ${input.vitaminAMcg ?? null}, ${input.vitaminCMg ?? null},
                   ${input.vitaminDMcg ?? null}, ${input.vitaminEMg ?? null},
                   ${input.vitaminKMcg ?? null},
                   ${input.vitaminB1Mg ?? null}, ${input.vitaminB2Mg ?? null},
                   ${input.vitaminB3Mg ?? null}, ${input.vitaminB5Mg ?? null},
                   ${input.vitaminB6Mg ?? null},
                   ${input.vitaminB7Mcg ?? null}, ${input.vitaminB9Mcg ?? null},
                   ${input.vitaminB12Mcg ?? null},
                   ${input.calciumMg ?? null}, ${input.ironMg ?? null},
                   ${input.magnesiumMg ?? null}, ${input.zincMg ?? null},
                   ${input.seleniumMcg ?? null},
                   ${input.copperMg ?? null}, ${input.manganeseMg ?? null},
                   ${input.chromiumMcg ?? null}, ${input.iodineMcg ?? null},
                   ${input.omega3Mg ?? null}, ${input.omega6Mg ?? null}
            FROM new_entry
          )
          SELECT id FROM new_entry`,
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

    // Insert nutrients into junction table
    const nutrientEntries = Object.entries(input.nutrients);
    if (nutrientEntries.length > 0) {
      const valuesClauses = nutrientEntries.map(
        ([nutrientId, amount]) => sql`(${inserted.id}::uuid, ${nutrientId}, ${amount})`,
      );
      await this.#db.execute(
        sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
            VALUES ${sql.join(valuesClauses, sql`, `)}
            ON CONFLICT (food_entry_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount`,
      );
    }

    return { ...inserted, nutrients: input.nutrients };
  }

  /** Update an existing food entry by id. */
  async update(input: UpdateFoodEntryInput): Promise<FoodEntryRow | null> {
    const { id, nutrients, ...fields } = input;

    // Separate food_entry fields from nutrient fields
    const foodEntryClauses: ReturnType<typeof sql>[] = [];
    const nutrientClauses: ReturnType<typeof sql>[] = [];

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
        continue;
      }

      // Check if it's a nutrient field
      const nutrientColumn = NUTRIENT_COLUMN_MAP[fieldName];
      if (nutrientColumn) {
        if (value === null) {
          nutrientClauses.push(sql`${sql.identifier(nutrientColumn)} = NULL`);
        } else {
          nutrientClauses.push(sql`${sql.identifier(nutrientColumn)} = ${value}`);
        }
      }
    }

    if (foodEntryClauses.length === 0 && nutrientClauses.length === 0 && !nutrients) return null;

    // Update food_entry_nutrition if any nutrient fields changed
    if (nutrientClauses.length > 0) {
      const nutrientSetExpression = sql.join(nutrientClauses, sql`, `);
      const ndIdRows = await this.#db.execute<{ nutrition_data_id: string | null }>(
        sql`SELECT nutrition_data_id
            FROM fitness.v_food_entry_with_nutrition
            WHERE id = ${id}::uuid
              AND user_id = ${this.#userId}
              AND confirmed = true`,
      );
      const existingNdId = ndIdRows[0]?.nutrition_data_id;
      if (existingNdId) {
        await this.#db.execute(
          sql`UPDATE fitness.food_entry_nutrition
              SET ${nutrientSetExpression}
              WHERE id = ${existingNdId}::uuid`,
        );
      } else if (ndIdRows.length > 0) {
        await this.#db.execute(
          sql`INSERT INTO fitness.food_entry_nutrition (food_entry_id, calories)
              VALUES (${id}::uuid, NULL)
              ON CONFLICT (food_entry_id) DO NOTHING`,
        );
        await this.#db.execute(
          sql`UPDATE fitness.food_entry_nutrition
              SET ${nutrientSetExpression}
              WHERE food_entry_id = ${id}::uuid`,
        );
      }
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
      await this.#db.execute(
        sql`DELETE FROM fitness.food_entry_nutrient
            WHERE food_entry_id = (
              SELECT id FROM fitness.food_entry
              WHERE id = ${id}::uuid AND user_id = ${this.#userId}
            )`,
      );
      const nutrientEntries = Object.entries(nutrients);
      if (nutrientEntries.length > 0) {
        const valuesClauses = nutrientEntries.map(
          ([nutrientId, amount]) => sql`(${id}::uuid, ${nutrientId}, ${amount})`,
        );
        await this.#db.execute(
          sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT food_entry_id, nutrient_id, amount
              FROM (VALUES ${sql.join(valuesClauses, sql`, `)}) AS vals(food_entry_id, nutrient_id, amount)
              WHERE food_entry_id IN (
                SELECT id FROM fitness.food_entry WHERE id = ${id}::uuid AND user_id = ${this.#userId}
              )`,
        );
      }
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

    const idRows = await executeWithSchema(
      this.#db,
      idRowSchema,
      sql`WITH new_entry AS (
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name
            ) VALUES (
              ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.date}::date,
              ${input.meal}, ${input.foodName}
            ) RETURNING id
          ),
          new_nutrition AS (
            INSERT INTO fitness.food_entry_nutrition (food_entry_id, calories, protein_g, carbs_g, fat_g)
            SELECT id, ${input.calories}, ${input.proteinG ?? null},
                   ${input.carbsG ?? null}, ${input.fatG ?? null}
            FROM new_entry
          )
          SELECT id FROM new_entry`,
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
