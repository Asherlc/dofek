import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { TrainingRepository } from "../repositories/training-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export {
  cardioPlan,
  computeComponentScores,
  computeFocusMuscles,
  computeReadinessScore,
  computeTrainingStreak,
  computeZonePercentages,
  daysAgoFromDate,
  getReadinessLevel,
  normalizeMuscleName,
  pickCardioFocus,
  pickStrengthSplit,
  shouldDoStrengthToday,
  shouldPreferRest,
} from "../repositories/training-repository.ts";
export type { NextWorkoutRecommendation } from "../repositories/training-repository.ts";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export const trainingRouter = router({
  weeklyVolume: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new TrainingRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getWeeklyVolume(input.days);
    }),

  hrZones: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new TrainingRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getHrZones(input.days);
    }),

  activityStats: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new TrainingRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getActivityStats(input.days);
    }),

  nextWorkout: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const weights = getEffectiveParams(storedParams).readinessWeights;

      const repo = new TrainingRepository(ctx.db, ctx.userId, ctx.timezone);
      const data = await repo.getNextWorkoutData(input.endDate);

      return repo.getRecommendation(data, input.endDate, weights);
    }),
});
