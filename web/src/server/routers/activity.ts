import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

export const activityRouter = router({
  list: publicProcedure
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_activity
            WHERE started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY started_at DESC`,
      );
      return rows;
    }),
});
