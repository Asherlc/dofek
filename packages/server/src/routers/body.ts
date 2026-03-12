import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const bodyRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(90),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT * FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY recorded_at DESC`,
      );
      return rows;
    }),
});
