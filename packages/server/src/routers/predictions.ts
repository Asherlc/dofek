import { z } from "zod";
import { PredictionsRepository } from "../repositories/predictions-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const predictionsRouter = router({
  /** Available prediction targets */
  targets: cachedProtectedQuery(CacheTTL.LONG).query(({ ctx }) => {
    const repo = new PredictionsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repo.getTargets().map((target) => target.toDetail());
  }),

  /**
   * Train models for the given target. Handles both daily targets
   * (HRV, resting HR, sleep, weight) and activity-level targets
   * (cardio power, strength volume).
   */
  predict: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        target: z.string().default("hrv"),
        days: z.number().default(365),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new PredictionsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.predict(input.target, input.days);
    }),
});
