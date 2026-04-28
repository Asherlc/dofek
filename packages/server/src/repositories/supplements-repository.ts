import type { Database } from "dofek/db";
import {
  nutrientAmountEntriesFromLegacyFields,
  nutrientColumnsToValues,
  nutrientFieldsSchema,
  nutrientRowSchema,
} from "dofek/db/nutrient-columns";
import { supplement, supplementNutrient } from "dofek/db/schema";
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
      // Delete existing supplements; supplement_nutrient cascades automatically.
      await tx.delete(supplement).where(eq(supplement.userId, this.#userId));

      if (supplements.length > 0) {
        for (let index = 0; index < supplements.length; index++) {
          const entry = supplements[index];
          if (!entry) continue;
          const [supplementRow] = await tx
            .insert(supplement)
            .values({
              userId: this.#userId,
              name: entry.name,
              amount: entry.amount ?? null,
              unit: entry.unit ?? null,
              form: entry.form ?? null,
              description: entry.description ?? null,
              meal: entry.meal ?? null,
              sortOrder: index,
            })
            .returning({ id: supplement.id });

          if (!supplementRow?.id) continue;
          const nutrientEntries = nutrientAmountEntriesFromLegacyFields(entry);
          if (nutrientEntries.length > 0) {
            await tx.insert(supplementNutrient).values(
              nutrientEntries.map((nutrientEntry) => ({
                supplementId: supplementRow.id,
                nutrientId: nutrientEntry.nutrientId,
                amount: nutrientEntry.amount,
              })),
            );
          }
        }
      }
    });
    return { success: true, count: supplements.length };
  }
}
