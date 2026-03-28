import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { InsightsRepository } from "../repositories/insights-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const insightsRouter = router({
  compute: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const repo = new InsightsRepository(ctx.db, ctx.userId);
      return repo.computeInsights(input.days, input.endDate);
    }),
});
