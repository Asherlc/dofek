import { TRPCError } from "@trpc/server";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  DailyMetricsRepository,
  HRV_BASELINE_WARMUP_DAYS,
} from "../repositories/daily-metrics-repository.ts";
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
  list: selectedChartDateRangeQuery(
    "dailyMetrics.list",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.list(range.days, input.endDate);
    },
  ),

  latest: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
    return repo.getLatest();
  }),

  hrvBaseline: selectedChartDateRangeQuery(
    "dailyMetrics.hrvBaseline",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore: requireSensorStore(ctx.sensorStore, "dailyMetrics.hrvBaseline"),
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: range.withWarmupDays(HRV_BASELINE_WARMUP_DAYS).days,
      });
      return repo.getHrvBaseline(range.days, input.endDate, restingHeartRateCte);
    },
  ),

  trends: selectedChartDateRangeQuery(
    "dailyMetrics.trends",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      const repo = new DailyMetricsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore: requireSensorStore(ctx.sensorStore, "dailyMetrics.trends"),
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: range.days,
      });
      return repo.getTrends(range.days, input.endDate, restingHeartRateCte);
    },
  ),
});
