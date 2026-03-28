import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { SleepNeedRepository } from "../repositories/sleep-need-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type {
  SleepNeedResult,
  SleepNight,
  SleepPerformanceInfo,
} from "../repositories/sleep-need-repository.ts";

/**
 * Whoop's sleep need formula:
 * Total need = baseline + strain debt + (accumulated debt recovery * 0.25)
 *
 * Baseline: personalized from 90-day average of nights where next-day readiness was above median.
 * Strain debt: extra sleep proportional to yesterday's training load.
 * Debt recovery: 25% of accumulated debt paid back per night.
 */

export const sleepNeedRouter = router({
  /**
   * Sleep Need Calculator — like Whoop's Sleep Coach.
   * Computes personalized sleep need and accumulated debt.
   */
  calculate: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new SleepNeedRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.calculate(input.endDate);
    }),

  /**
   * Sleep performance score for last night: how well did you sleep relative to need.
   * Returns score (0-100), tier (Peak/Perform/Get By/Low), and recommended bedtime.
   */
  performance: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new SleepNeedRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getPerformance(input.endDate);
    }),
});
