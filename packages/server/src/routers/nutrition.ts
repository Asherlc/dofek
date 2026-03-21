import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const nutritionDailyRowSchema = z.object({
  date: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  water_ml: z.coerce.number().nullable(),
  created_at: z.string(),
});

export const nutritionRouter = router({
  daily: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        nutritionDailyRowSchema,
        sql`SELECT * FROM fitness.nutrition_daily
            WHERE user_id = ${ctx.userId}
              AND date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );
      return rows;
    }),
});
