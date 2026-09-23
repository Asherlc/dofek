import type { Database } from "dofek/db";
import { nullableNutrientAmountEntriesFromLegacyFields } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { type FoodEntryRow, foodEntryRowSchema } from "./food-entry-models.ts";

const fieldColumnMap: Record<string, string> = {
  date: "date",
  meal: "meal",
  foodName: "food_name",
  foodDescription: "food_description",
  category: "category",
  numberOfUnits: "number_of_units",
};

export interface UpdateFoodEntryInput {
  id: string;
  nutrients?: Record<string, number>;
  [key: string]: unknown;
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

/** Data access for user-owned food entry updates and deletes. */
export class FoodEntryUpdateRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
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
}
