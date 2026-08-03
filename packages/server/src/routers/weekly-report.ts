import { captureException } from "@sentry/node";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  type ReportRecovery,
  reportRefreshErrorMessage,
  weeklyReportRecovery,
} from "../contracts/report-recovery.ts";
import { endDateSchema } from "../lib/date-window.ts";
import {
  type WeeklyReportResult as RepositoryWeeklyReportData,
  WeeklyReportRepository,
} from "../repositories/weekly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { WeekSummary } from "../repositories/weekly-report-repository.ts";

export type WeeklyReportData = RepositoryWeeklyReportData;
export type WeeklyReportResult = WeeklyReportData & { recovery: ReportRecovery };

export const weeklyReportRouter = router({
  /**
   * Weekly Performance Report — mirrors Whoop's Weekly Performance Assessment.
   * Aggregates training load, sleep performance, readiness, and key vitals per Sunday-start week.
   */
  report: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ weeks: z.number().min(1).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const recovery = weeklyReportRecovery(input.weeks, input.endDate);
      try {
        const report = await new WeeklyReportRepository(ctx.userId, ctx.sensorStore).getReport(
          input.weeks,
          input.endDate,
        );
        return { ...report, recovery };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        captureException(error, {
          tags: { reportType: "weekly" },
          extra: {
            startDate: recovery.range.startDate,
            endDate: recovery.range.endDate,
          },
        });
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: reportRefreshErrorMessage("weekly", recovery.range),
          cause: error,
        });
      }
    }),
});
