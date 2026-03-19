import { supplement } from "dofek/db/schema";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const supplementSchema = z.object({
  name: z.string().min(1).max(200),
  amount: z.number().positive().optional(),
  unit: z.string().max(10).optional(),
  form: z.string().optional(),
  description: z.string().optional(),
  meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  calories: z.number().optional(),
  proteinG: z.number().optional(),
  carbsG: z.number().optional(),
  fatG: z.number().optional(),
  saturatedFatG: z.number().optional(),
  polyunsaturatedFatG: z.number().optional(),
  monounsaturatedFatG: z.number().optional(),
  transFatG: z.number().optional(),
  cholesterolMg: z.number().optional(),
  sodiumMg: z.number().optional(),
  potassiumMg: z.number().optional(),
  fiberG: z.number().optional(),
  sugarG: z.number().optional(),
  vitaminAMcg: z.number().optional(),
  vitaminCMg: z.number().optional(),
  vitaminDMcg: z.number().optional(),
  vitaminEMg: z.number().optional(),
  vitaminKMcg: z.number().optional(),
  vitaminB1Mg: z.number().optional(),
  vitaminB2Mg: z.number().optional(),
  vitaminB3Mg: z.number().optional(),
  vitaminB5Mg: z.number().optional(),
  vitaminB6Mg: z.number().optional(),
  vitaminB7Mcg: z.number().optional(),
  vitaminB9Mcg: z.number().optional(),
  vitaminB12Mcg: z.number().optional(),
  calciumMg: z.number().optional(),
  ironMg: z.number().optional(),
  magnesiumMg: z.number().optional(),
  zincMg: z.number().optional(),
  seleniumMcg: z.number().optional(),
  copperMg: z.number().optional(),
  manganeseMg: z.number().optional(),
  chromiumMcg: z.number().optional(),
  iodineMcg: z.number().optional(),
  omega3Mg: z.number().optional(),
  omega6Mg: z.number().optional(),
});

export type Supplement = z.infer<typeof supplementSchema>;

/** Map a DB supplement row to the API shape (strip DB-only fields). */
function toApiSupplement(row: typeof supplement.$inferSelect): Supplement {
  const result: Supplement = { name: row.name };
  if (row.amount != null) result.amount = row.amount;
  if (row.unit != null) result.unit = row.unit;
  if (row.form != null) result.form = row.form;
  if (row.description != null) result.description = row.description;
  if (row.meal != null) result.meal = row.meal;
  if (row.calories != null) result.calories = row.calories;
  if (row.proteinG != null) result.proteinG = row.proteinG;
  if (row.carbsG != null) result.carbsG = row.carbsG;
  if (row.fatG != null) result.fatG = row.fatG;
  if (row.saturatedFatG != null) result.saturatedFatG = row.saturatedFatG;
  if (row.polyunsaturatedFatG != null) result.polyunsaturatedFatG = row.polyunsaturatedFatG;
  if (row.monounsaturatedFatG != null) result.monounsaturatedFatG = row.monounsaturatedFatG;
  if (row.transFatG != null) result.transFatG = row.transFatG;
  if (row.cholesterolMg != null) result.cholesterolMg = row.cholesterolMg;
  if (row.sodiumMg != null) result.sodiumMg = row.sodiumMg;
  if (row.potassiumMg != null) result.potassiumMg = row.potassiumMg;
  if (row.fiberG != null) result.fiberG = row.fiberG;
  if (row.sugarG != null) result.sugarG = row.sugarG;
  if (row.vitaminAMcg != null) result.vitaminAMcg = row.vitaminAMcg;
  if (row.vitaminCMg != null) result.vitaminCMg = row.vitaminCMg;
  if (row.vitaminDMcg != null) result.vitaminDMcg = row.vitaminDMcg;
  if (row.vitaminEMg != null) result.vitaminEMg = row.vitaminEMg;
  if (row.vitaminKMcg != null) result.vitaminKMcg = row.vitaminKMcg;
  if (row.vitaminB1Mg != null) result.vitaminB1Mg = row.vitaminB1Mg;
  if (row.vitaminB2Mg != null) result.vitaminB2Mg = row.vitaminB2Mg;
  if (row.vitaminB3Mg != null) result.vitaminB3Mg = row.vitaminB3Mg;
  if (row.vitaminB5Mg != null) result.vitaminB5Mg = row.vitaminB5Mg;
  if (row.vitaminB6Mg != null) result.vitaminB6Mg = row.vitaminB6Mg;
  if (row.vitaminB7Mcg != null) result.vitaminB7Mcg = row.vitaminB7Mcg;
  if (row.vitaminB9Mcg != null) result.vitaminB9Mcg = row.vitaminB9Mcg;
  if (row.vitaminB12Mcg != null) result.vitaminB12Mcg = row.vitaminB12Mcg;
  if (row.calciumMg != null) result.calciumMg = row.calciumMg;
  if (row.ironMg != null) result.ironMg = row.ironMg;
  if (row.magnesiumMg != null) result.magnesiumMg = row.magnesiumMg;
  if (row.zincMg != null) result.zincMg = row.zincMg;
  if (row.seleniumMcg != null) result.seleniumMcg = row.seleniumMcg;
  if (row.copperMg != null) result.copperMg = row.copperMg;
  if (row.manganeseMg != null) result.manganeseMg = row.manganeseMg;
  if (row.chromiumMcg != null) result.chromiumMcg = row.chromiumMcg;
  if (row.iodineMcg != null) result.iodineMcg = row.iodineMcg;
  if (row.omega3Mg != null) result.omega3Mg = row.omega3Mg;
  if (row.omega6Mg != null) result.omega6Mg = row.omega6Mg;
  return result;
}

export const supplementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(supplement)
      .where(eq(supplement.userId, ctx.userId))
      .orderBy(asc(supplement.sortOrder));
    return rows.map(toApiSupplement);
  }),

  save: protectedProcedure
    .input(z.object({ supplements: z.array(supplementSchema) }))
    .mutation(async ({ ctx, input }) => {
      // Replace all supplements for this user: delete existing, insert new list
      await ctx.db.transaction(async (tx) => {
        await tx.delete(supplement).where(eq(supplement.userId, ctx.userId));
        if (input.supplements.length > 0) {
          await tx.insert(supplement).values(
            input.supplements.map((s, i) => ({
              userId: ctx.userId,
              name: s.name,
              amount: s.amount ?? null,
              unit: s.unit ?? null,
              form: s.form ?? null,
              description: s.description ?? null,
              meal: s.meal ?? null,
              sortOrder: i,
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
            })),
          );
        }
      });
      return { success: true, count: input.supplements.length };
    }),
});
