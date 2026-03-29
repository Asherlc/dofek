import { dateWindowInput } from "../lib/date-window.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { HrvBaselineRow } from "../repositories/daily-metrics-repository.ts";

export const dailyMetricsRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId);
      return repo.list(input.days, input.endDate);
    }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new DailyMetricsRepository(ctx.db, ctx.userId);
    return repo.getLatest();
  }),

  hrvBaseline: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId);
      return repo.getHrvBaseline(input.days, input.endDate);
    }),

  trends: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId);
      return repo.getTrends(input.days, input.endDate);
    }),
});
