import { captureException } from "@sentry/node";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  monthlyReportRecovery,
  type ReportRecovery,
  reportRefreshErrorMessage,
} from "../contracts/report-recovery.ts";
import { endDateSchema } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  MonthlyReportRepository,
  type MonthSummary,
  type MonthlyReportResult as RepositoryMonthlyReportData,
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

export type { MonthSummary };

export type MonthlyReportData = RepositoryMonthlyReportData;
export type MonthlyReportResult = MonthlyReportData & { recovery: ReportRecovery };

export const monthlyReportRouter = router({
  /**
   * Monthly Performance Report — aggregates training, sleep, and vitals per calendar month
   * with month-over-month trends.
   */
  report: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(
      z.object({
        months: z.number().min(1).max(24).default(6),
        endDate: endDateSchema,
      }),
    )
    .query(async ({ ctx, input }): Promise<MonthlyReportResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "monthlyReport.report");
      const repo = new MonthlyReportRepository(ctx.userId, sensorStore);
      const recovery = monthlyReportRecovery(input.months, input.endDate);
      try {
        const report = await repo.getReport(input.months, input.endDate);
        return { ...report, recovery };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        captureException(error, {
          tags: { reportType: "monthly" },
          extra: {
            startDate: recovery.range.startDate,
            endDate: recovery.range.endDate,
          },
        });
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: reportRefreshErrorMessage("monthly", recovery.range),
          cause: error,
        });
      }
    }),
});
