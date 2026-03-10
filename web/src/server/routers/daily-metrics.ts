import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

export const dailyMetricsRouter = router({
  list: publicProcedure
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_daily_metrics
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date DESC`,
      );
      return rows;
    }),

  latest: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.execute(
      sql`SELECT * FROM fitness.v_daily_metrics ORDER BY date DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }),
});
