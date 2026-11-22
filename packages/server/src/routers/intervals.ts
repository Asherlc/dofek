import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ActivityRepository,
  type ActivitySensorStore,
} from "../repositories/activity-repository.ts";
import { IntervalsRepository } from "../repositories/intervals-repository.ts";
import {
  getPlannedIntervalComparisons,
  plannedIntervalComparisonSchema,
} from "../repositories/planned-interval-comparison.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

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

export const intervalsRouter = router({
  /**
   * Get intervals/laps for a specific activity.
   * Computes per-interval metrics from sensor stream based on interval time ranges.
   */
  byActivity: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ activityId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "intervals.byActivity");
      const repo = new IntervalsRepository(ctx.db, ctx.userId, sensorStore);
      return repo.getByActivity(input.activityId);
    }),

  /**
   * Eligible FIT planned-versus-recorded laps for one visible activity (any merged member ID).
   * Empty when the activity is not visible or has no eligible plan. Uncached: visibility depends
   * on the caller's current access window and on deletes or merges that a cache key cannot see.
   */
  plannedByActivity: protectedProcedure
    .input(z.object({ activityId: z.guid() }))
    .output(z.array(plannedIntervalComparisonSchema))
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "intervals.plannedByActivity");
      const window = await new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        sensorStore,
      ).findSensorWindow(input.activityId);
      if (!window) return [];
      return getPlannedIntervalComparisons(ctx.db, sensorStore, ctx.userId, window);
    }),

  /**
   * Auto-detect intervals from sensor stream data for an activity.
   * Splits activity into intervals based on significant changes in intensity.
   */
  detect: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ activityId: z.guid() }))
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "intervals.detect");
      const repo = new IntervalsRepository(ctx.db, ctx.userId, sensorStore);
      return repo.detect(input.activityId);
    }),
});
