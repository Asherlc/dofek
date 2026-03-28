import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { HealthspanRepository } from "../repositories/healthspan-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { HealthspanMetric, HealthspanResult } from "../repositories/healthspan-repository.ts";
export {
  scoreToStatus,
  scoreSleepConsistency,
  scoreSleepDuration,
  scoreAerobicMinutes,
  scoreHighIntensityMinutes,
  scoreStrengthFrequency,
  scoreSteps,
  scoreVo2Max,
  scoreRestingHr,
  scoreLeanMassPct,
} from "../repositories/healthspan-repository.ts";

export const healthspanRouter = router({
  /**
   * Healthspan Score — composite longevity metric inspired by Whoop's Healthspan.
   * Updates weekly from rolling 4-week data windows.
   */
  score: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(4).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const repo = new HealthspanRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getScore(input.weeks, input.endDate);
    }),
});
