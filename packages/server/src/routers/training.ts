import { TRPCError } from "@trpc/server";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
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
import { CacheTTL, router } from "../trpc.ts";

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
  weeklyVolume: selectedChartRangeQuery(
    "training.weeklyVolume",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getWeeklyVolume(range.days);
    },
  ),

  hrZones: selectedChartRangeQuery("training.hrZones", CacheTTL.LONG, async ({ ctx, range }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "training");
    const repo = new TrainingRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      sensorStore,
      ctx.accessWindow,
    );
    return repo.getHrZones(range.days);
  }),

  activityStats: selectedChartRangeQuery(
    "training.activityStats",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getActivityStats(range.days);
    },
  ),
});
