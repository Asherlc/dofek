import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import type {
  DailyStressRow,
  StressResult,
  WeeklyStressRow,
} from "../repositories/stress-repository.ts";
import { StressRepository } from "../repositories/stress-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { DailyStressRow, StressResult, WeeklyStressRow };

export const stressRouter = router({
  /**
   * Stress Monitor — daily stress scores from HR/HRV deviation against personal baselines.
   * Mirrors Whoop's 0-3 stress scale with cumulative weekly tracking.
   */
  scores: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StressResult> => {
      const repo = new StressRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getStressScores(input.days, input.endDate);
    }),
});
