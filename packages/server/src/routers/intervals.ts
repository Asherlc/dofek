import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { IntervalsRepository } from "../repositories/intervals-repository.ts";
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
