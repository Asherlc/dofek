import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  DailyMetricsRepository,
  HRV_BASELINE_WARMUP_DAYS,
  trendsRowSchema,
} from "../repositories/daily-metrics-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import {
  buildDailyMetricHealthStatuses,
  healthStatusMetricSchema,
} from "../services/health-status.ts";
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
      const trends = await repo.getTrends(range.days, input.endDate, restingHeartRateCte);
      return trends ? { ...trends, healthStatus: buildDailyMetricHealthStatuses(trends) } : null;
    },
    {
      outputSchema: trendsRowSchema
        .extend({ healthStatus: z.array(healthStatusMetricSchema) })
        .nullable(),
    },
  ),
});
