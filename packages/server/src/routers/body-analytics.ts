import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type {
  BodyRecompositionRow,
  SmoothedWeightRow,
} from "../repositories/body-analytics-repository.ts";

// ── Router ───────────────────────────────────────────────────────────

export const bodyAnalyticsRouter = router({
  smoothedWeight: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getSmoothedWeight(input.days, input.endDate);
    }),

  recomposition: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(180), endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getRecomposition(input.days, input.endDate);
    }),

  weightTrend: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({}).default({}))
    .query(({ ctx }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getWeightTrend();
    }),
});
