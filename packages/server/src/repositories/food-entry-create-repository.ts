import type { Database } from "dofek/db";
import { nutrientAmountEntriesFromLegacyFields } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { type FoodEntryRow, foodEntryRowSchema } from "./food-entry-models.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const DOFEK_PROVIDER_ID = "dofek";
const idRowSchema = z.object({ id: z.string() });

export interface CreateFoodEntryInput {
  externalId?: string | null;
  date: string;
  meal?: string | null;
  foodName: string;
  foodDescription?: string | null;
  category?: string | null;
  numberOfUnits?: number | null;
  servingUnit?: string | null;
  servingWeightGrams?: number | null;
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

/** Data access for user-created food entry inserts. */
export class FoodEntryCreateRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
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
    const foodEntryInsert = sql`INSERT INTO fitness.food_entry (
      user_id, provider_id, external_id, date, meal, food_name, food_description,
      category, number_of_units, serving_unit, serving_weight_grams, nutrition_grain
    ) VALUES (
      ${this.#userId}, ${DOFEK_PROVIDER_ID}, ${input.externalId ?? null}, ${input.date}::date,
      ${input.meal ?? null}, ${input.foodName}, ${input.foodDescription ?? null},
      ${input.category ?? null}, ${input.numberOfUnits ?? null}, ${input.servingUnit ?? null},
      ${input.servingWeightGrams ?? null}, 'itemized'
    )`;

    const idRows = await executeWithSchema(
      this.#db,
      idRowSchema,
      nutrientValueClauses.length > 0
        ? sql`WITH new_entry AS (
          ${foodEntryInsert} RETURNING id
        ),
        new_nutrients AS (
          INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
          SELECT id, nutrient_id, amount
          FROM new_entry
          CROSS JOIN (VALUES ${sql.join(nutrientValueClauses, sql`, `)}) AS vals(nutrient_id, amount)
        )
        SELECT id FROM new_entry`
        : sql`${foodEntryInsert} RETURNING id`,
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
