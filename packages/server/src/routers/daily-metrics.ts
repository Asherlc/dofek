import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { baselineRelativeMetricSchema } from "../contracts/baseline-relative-metrics.ts";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  DailyMetricsRepository,
  HRV_BASELINE_WARMUP_DAYS,
  trendsRowSchema,
} from "../repositories/daily-metrics-repository.ts";
import {
  latestRecoveryBaselineMetrics,
  RecoveryBaselineRepository,
} from "../repositories/recovery-baseline-repository.ts";
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
      const sensorStore = requireSensorStore(ctx.sensorStore, "dailyMetrics.trends");
      const baselineRepository = new RecoveryBaselineRepository(
        ctx.userId,
        sensorStore,
        ctx.accessWindow,
      );
      const baselineStartDate =
        range.days === null
          ? "1970-01-01"
          : dateWindowStartString(input.endDate, Math.max(0, range.days - 1));
      const [restingHeartRateCte, baselineRows] = await Promise.all([
        fetchRestingHeartRateValuesCte({
          sensorStore,
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: input.endDate,
          days: range.days,
        }),
        baselineRepository.listRange(baselineStartDate, input.endDate, {
          priority: "dashboard",
        }),
      ]);
      const trends = await repo.getTrends(range.days, input.endDate, restingHeartRateCte);
      const baselineRelative = latestRecoveryBaselineMetrics(baselineRows);
      return trends
        ? {
            ...trends,
            baselineRelative,
            healthStatus: buildDailyMetricHealthStatuses(trends, baselineRelative),
          }
        : null;
    },
    {
      outputSchema: trendsRowSchema
        .extend({
          baselineRelative: z.array(baselineRelativeMetricSchema),
          healthStatus: z.array(healthStatusMetricSchema),
        })
        .nullable(),
    },
  ),
});
