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

/** Fields that are optional in the API shape and nullable in the DB row. */
export const OPTIONAL_FIELDS = [
  "amount",
  "unit",
  "form",
  "description",
  "meal",
  "calories",
  "proteinG",
  "carbsG",
  "fatG",
  "saturatedFatG",
  "polyunsaturatedFatG",
  "monounsaturatedFatG",
  "transFatG",
  "cholesterolMg",
  "sodiumMg",
  "potassiumMg",
  "fiberG",
  "sugarG",
  "vitaminAMcg",
  "vitaminCMg",
  "vitaminDMcg",
  "vitaminEMg",
  "vitaminKMcg",
  "vitaminB1Mg",
  "vitaminB2Mg",
  "vitaminB3Mg",
  "vitaminB5Mg",
  "vitaminB6Mg",
  "vitaminB7Mcg",
  "vitaminB9Mcg",
  "vitaminB12Mcg",
  "calciumMg",
  "ironMg",
  "magnesiumMg",
  "zincMg",
  "seleniumMcg",
  "copperMg",
  "manganeseMg",
  "chromiumMcg",
  "iodineMcg",
  "omega3Mg",
  "omega6Mg",
] as const;

type SupplementRow = typeof supplement.$inferSelect;

/** Map a DB supplement row to the API shape (strip DB-only fields). */
export function toApiSupplement(row: SupplementRow): Supplement {
  const result: Record<string, unknown> = { name: row.name };
  for (const key of OPTIONAL_FIELDS) {
    if (row[key] != null) {
      result[key] = row[key];
    }
  }
  return supplementSchema.parse(result);
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
