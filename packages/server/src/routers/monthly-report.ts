import { z } from "zod";
import { MonthlyReportRepository } from "../repositories/monthly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface MonthSummary {
  monthStart: string;
  trainingHours: number;
  activityCount: number;
  avgDailyStrain: number;
  avgSleepMinutes: number;
  avgRestingHr: number | null;
  avgHrv: number | null;
  /** Month-over-month % change in training hours (null for first month) */
  trainingHoursTrend: number | null;
  /** Month-over-month % change in avg sleep (null for first month) */
  avgSleepTrend: number | null;
}

export interface MonthlyReportResult {
  current: MonthSummary | null;
  history: MonthSummary[];
}

export const monthlyReportRouter = router({
  /**
   * Monthly Performance Report — aggregates training, sleep, and vitals per calendar month
   * with month-over-month trends.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }): Promise<MonthlyReportResult> => {
      const repo = new MonthlyReportRepository(ctx.db, ctx.userId);
      return repo.getReport(input.months);
    }),
});
