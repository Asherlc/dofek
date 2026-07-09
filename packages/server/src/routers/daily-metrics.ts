import { TRPCError } from "@trpc/server";
import { rangeDaysOrNullAdd, selectedChartDateRangeInput } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { HrvBaselineRow } from "../repositories/daily-metrics-repository.ts";

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

export const dailyMetricsRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartDateRangeInput("dailyMetrics.list"))
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.list(input.days, input.endDate);
    }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
    return repo.getLatest();
  }),

  hrvBaseline: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartDateRangeInput("dailyMetrics.hrvBaseline"))
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore: requireSensorStore(ctx.sensorStore, "dailyMetrics.hrvBaseline"),
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: rangeDaysOrNullAdd(input.days, 60),
      });
      return repo.getHrvBaseline(input.days, input.endDate, restingHeartRateCte);
    }),

  trends: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartDateRangeInput("dailyMetrics.trends"))
    .query(async ({ ctx, input }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore: requireSensorStore(ctx.sensorStore, "dailyMetrics.trends"),
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: input.days,
      });
      return repo.getTrends(input.days, input.endDate, restingHeartRateCte);
    }),
});
