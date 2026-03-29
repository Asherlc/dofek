import type { Database } from "dofek/db";
import {
  nutrientColumnsToValues,
  nutrientFieldsSchema,
  nutrientRowSchema,
} from "dofek/db/nutrient-columns";
import { nutritionData, supplement } from "dofek/db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const supplementSchema = z
  .object({
    name: z.string().min(1).max(200),
    amount: z.number().positive().optional(),
    unit: z.string().max(10).optional(),
    form: z.string().optional(),
    description: z.string().optional(),
    meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  })
  .merge(nutrientFieldsSchema.partial());

export type Supplement = z.infer<typeof supplementSchema>;

/** Non-nutrient optional fields on the supplement API shape. */
const NON_NUTRIENT_OPTIONAL_FIELDS = ["amount", "unit", "form", "description", "meal"] as const;

/** Zod schema for v_supplement_with_nutrition rows */
const supplementViewRowSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    amount: z.coerce.number().nullable(),
    unit: z.string().nullable(),
    form: z.string().nullable(),
    description: z.string().nullable(),
    meal: z.string().nullable(),
    sort_order: z.number(),
    nutrition_data_id: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .merge(nutrientRowSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a DB view row (snake_case) to the API shape (camelCase). */
export function toApiSupplement(row: Record<string, unknown>): Supplement {
  const result: Record<string, unknown> = { name: row.name };

  // Copy non-nutrient optional fields (same name in view and API)
  for (const key of NON_NUTRIENT_OPTIONAL_FIELDS) {
    if (row[key] != null) result[key] = row[key];
  }

  // Convert snake_case nutrient columns from the view to camelCase for the API
  const nutrients = nutrientColumnsToValues(row);
  for (const [key, value] of Object.entries(nutrients)) {
    if (value != null) result[key] = value;
  }

  return supplementSchema.parse(result);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SupplementsRepository {
  readonly #db: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute" | "transaction">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** List all supplements for this user, ordered by sort_order. */
  async list(): Promise<Supplement[]> {
    const rows = await executeWithSchema(
      this.#db,
      supplementViewRowSchema,
      sql`SELECT * FROM fitness.v_supplement_with_nutrition
          WHERE user_id = ${this.#userId}
          ORDER BY sort_order ASC`,
    );
    return rows.map((row) => toApiSupplement(row));
  }

  /** Replace all supplements for this user (transactional). */
  async save(supplements: Supplement[]): Promise<{ success: boolean; count: number }> {
    await this.#db.transaction(async (tx) => {
      // Delete existing supplements and their nutrition_data
      const existing = await tx
        .select({ nutritionDataId: supplement.nutritionDataId })
        .from(supplement)
        .where(eq(supplement.userId, this.#userId));

      await tx.delete(supplement).where(eq(supplement.userId, this.#userId));

      // Clean up orphaned nutrition_data rows
      const nutritionIds = existing
        .map((row) => row.nutritionDataId)
        .filter((id): id is string => id != null);
      if (nutritionIds.length > 0) {
        await tx.delete(nutritionData).where(sql`id = ANY(${nutritionIds})`);
      }

      if (supplements.length > 0) {
        for (let index = 0; index < supplements.length; index++) {
          const entry = supplements[index];
          if (!entry) continue;
          // Insert nutrition_data first with explicitly typed nutrient values
          const [nutritionDataRow] = await tx
            .insert(nutritionData)
            .values({
              calories: entry.calories ?? null,
              proteinG: entry.proteinG ?? null,
              carbsG: entry.carbsG ?? null,
              fatG: entry.fatG ?? null,
              saturatedFatG: entry.saturatedFatG ?? null,
              polyunsaturatedFatG: entry.polyunsaturatedFatG ?? null,
              monounsaturatedFatG: entry.monounsaturatedFatG ?? null,
              transFatG: entry.transFatG ?? null,
              cholesterolMg: entry.cholesterolMg ?? null,
              sodiumMg: entry.sodiumMg ?? null,
              potassiumMg: entry.potassiumMg ?? null,
              fiberG: entry.fiberG ?? null,
              sugarG: entry.sugarG ?? null,
              vitaminAMcg: entry.vitaminAMcg ?? null,
              vitaminCMg: entry.vitaminCMg ?? null,
              vitaminDMcg: entry.vitaminDMcg ?? null,
              vitaminEMg: entry.vitaminEMg ?? null,
              vitaminKMcg: entry.vitaminKMcg ?? null,
              vitaminB1Mg: entry.vitaminB1Mg ?? null,
              vitaminB2Mg: entry.vitaminB2Mg ?? null,
              vitaminB3Mg: entry.vitaminB3Mg ?? null,
              vitaminB5Mg: entry.vitaminB5Mg ?? null,
              vitaminB6Mg: entry.vitaminB6Mg ?? null,
              vitaminB7Mcg: entry.vitaminB7Mcg ?? null,
              vitaminB9Mcg: entry.vitaminB9Mcg ?? null,
              vitaminB12Mcg: entry.vitaminB12Mcg ?? null,
              calciumMg: entry.calciumMg ?? null,
              ironMg: entry.ironMg ?? null,
              magnesiumMg: entry.magnesiumMg ?? null,
              zincMg: entry.zincMg ?? null,
              seleniumMcg: entry.seleniumMcg ?? null,
              copperMg: entry.copperMg ?? null,
              manganeseMg: entry.manganeseMg ?? null,
              chromiumMcg: entry.chromiumMcg ?? null,
              iodineMcg: entry.iodineMcg ?? null,
              omega3Mg: entry.omega3Mg ?? null,
              omega6Mg: entry.omega6Mg ?? null,
            })
            .returning({ id: nutritionData.id });

          // Insert supplement with FK
          await tx.execute(
            sql`INSERT INTO fitness.supplement (user_id, name, amount, unit, form, description, meal, sort_order, nutrition_data_id)
                VALUES (${this.#userId}, ${entry.name}, ${entry.amount ?? null}, ${entry.unit ?? null},
                        ${entry.form ?? null}, ${entry.description ?? null}, ${entry.meal ?? null},
                        ${index}, ${nutritionDataRow?.id})`,
          );
        }
      }
    });
    return { success: true, count: supplements.length };
  }
}
