import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

export const nutritionRouter = router({
  daily: publicProcedure
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.nutrition_daily
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );
      return rows;
    }),
});
