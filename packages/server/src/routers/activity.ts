import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY started_at DESC`,
      );
      return rows;
    }),
});
