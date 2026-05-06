import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
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
} from "../repositories/training-recommendation.ts";
import { TrainingRepository } from "../repositories/training-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

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
};

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
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getWeeklyVolume(input.days);
    }),

  hrZones: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getHrZones(input.days);
    }),

  activityStats: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getActivityStats(input.days);
    }),

  nextWorkout: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const weights = getEffectiveParams(storedParams).readinessWeights;

      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      const data = await repo.getNextWorkoutData(input.endDate);

      return repo.getRecommendation(data, input.endDate, weights);
    }),
});
