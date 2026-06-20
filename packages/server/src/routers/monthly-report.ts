import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  MonthlyReportRepository,
  type MonthlyReportResult,
  type MonthSummary,
} from "../repositories/monthly-report-repository.ts";
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

export type { MonthSummary, MonthlyReportResult };

export const monthlyReportRouter = router({
  /**
   * Monthly Performance Report — aggregates training, sleep, and vitals per calendar month
   * with month-over-month trends.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }): Promise<MonthlyReportResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "monthlyReport.report");
      const repo = new MonthlyReportRepository(ctx.userId, sensorStore, ctx.timezone);
      return repo.getReport(input.months);
    }),
});
