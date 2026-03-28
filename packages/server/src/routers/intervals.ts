import { z } from "zod";
import { IntervalsRepository } from "../repositories/intervals-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// Re-export utility functions for backward compatibility
export { average, maxVal, summarizeSegment } from "../repositories/intervals-repository.ts";

export const intervalsRouter = router({
  /**
   * Get intervals/laps for a specific activity.
   * Computes per-interval metrics from metric_stream based on interval time ranges.
   */
  byActivity: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ activityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const repo = new IntervalsRepository(ctx.db, ctx.userId);
      return repo.getByActivity(input.activityId);
    }),

  /**
   * Auto-detect intervals from metric_stream data for an activity.
   * Splits activity into intervals based on significant changes in intensity.
   * Uses a simple approach: segments where power or HR changes by > 15% from
   * a rolling baseline indicate a new interval.
   *
   * Returns computed intervals without saving them — caller decides whether to persist.
   */
  detect: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ activityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const repo = new IntervalsRepository(ctx.db, ctx.userId);
      return repo.detect(input.activityId);
    }),
});
