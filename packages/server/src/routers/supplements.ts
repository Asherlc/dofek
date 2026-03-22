import { nutrientColumnsToValues, nutrientFieldsSchema } from "dofek/db/nutrient-columns";
import { nutritionData, supplement } from "dofek/db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const supplementSchema = z
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

export const supplementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_supplement_with_nutrition
          WHERE user_id = ${ctx.userId}
          ORDER BY sort_order ASC`,
    );
    return Array.from(rows).map((row) => toApiSupplement(row));
  }),

  save: protectedProcedure
    .input(z.object({ supplements: z.array(supplementSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        // Delete existing supplements and their nutrition_data
        const existing = await tx
          .select({ nutritionDataId: supplement.nutritionDataId })
          .from(supplement)
          .where(eq(supplement.userId, ctx.userId));

        await tx.delete(supplement).where(eq(supplement.userId, ctx.userId));

        // Clean up orphaned nutrition_data rows
        const nutritionIds = existing
          .map((r) => r.nutritionDataId)
          .filter((id): id is string => id != null);
        if (nutritionIds.length > 0) {
          await tx.delete(nutritionData).where(sql`id = ANY(${nutritionIds})`);
        }

        if (input.supplements.length > 0) {
          for (let i = 0; i < input.supplements.length; i++) {
            const s = input.supplements[i];
            if (!s) continue;
            // Insert nutrition_data first with explicitly typed nutrient values
            const [ndRow] = await tx
              .insert(nutritionData)
              .values({
                calories: s.calories ?? null,
                proteinG: s.proteinG ?? null,
                carbsG: s.carbsG ?? null,
                fatG: s.fatG ?? null,
                saturatedFatG: s.saturatedFatG ?? null,
                polyunsaturatedFatG: s.polyunsaturatedFatG ?? null,
                monounsaturatedFatG: s.monounsaturatedFatG ?? null,
                transFatG: s.transFatG ?? null,
                cholesterolMg: s.cholesterolMg ?? null,
                sodiumMg: s.sodiumMg ?? null,
                potassiumMg: s.potassiumMg ?? null,
                fiberG: s.fiberG ?? null,
                sugarG: s.sugarG ?? null,
                vitaminAMcg: s.vitaminAMcg ?? null,
                vitaminCMg: s.vitaminCMg ?? null,
                vitaminDMcg: s.vitaminDMcg ?? null,
                vitaminEMg: s.vitaminEMg ?? null,
                vitaminKMcg: s.vitaminKMcg ?? null,
                vitaminB1Mg: s.vitaminB1Mg ?? null,
                vitaminB2Mg: s.vitaminB2Mg ?? null,
                vitaminB3Mg: s.vitaminB3Mg ?? null,
                vitaminB5Mg: s.vitaminB5Mg ?? null,
                vitaminB6Mg: s.vitaminB6Mg ?? null,
                vitaminB7Mcg: s.vitaminB7Mcg ?? null,
                vitaminB9Mcg: s.vitaminB9Mcg ?? null,
                vitaminB12Mcg: s.vitaminB12Mcg ?? null,
                calciumMg: s.calciumMg ?? null,
                ironMg: s.ironMg ?? null,
                magnesiumMg: s.magnesiumMg ?? null,
                zincMg: s.zincMg ?? null,
                seleniumMcg: s.seleniumMcg ?? null,
                copperMg: s.copperMg ?? null,
                manganeseMg: s.manganeseMg ?? null,
                chromiumMcg: s.chromiumMcg ?? null,
                iodineMcg: s.iodineMcg ?? null,
                omega3Mg: s.omega3Mg ?? null,
                omega6Mg: s.omega6Mg ?? null,
              })
              .returning({ id: nutritionData.id });

            // Insert supplement with FK
            await tx.execute(
              sql`INSERT INTO fitness.supplement (user_id, name, amount, unit, form, description, meal, sort_order, nutrition_data_id)
                  VALUES (${ctx.userId}, ${s.name}, ${s.amount ?? null}, ${s.unit ?? null},
                          ${s.form ?? null}, ${s.description ?? null}, ${s.meal ?? null},
                          ${i}, ${ndRow?.id})`,
            );
          }
        }
      });
      return { success: true, count: input.supplements.length };
    }),
});
