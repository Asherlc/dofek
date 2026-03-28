import { z } from "zod";
import {
  MonthlyReportRepository,
  type MonthlyReportResult,
} from "../repositories/monthly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type {
  MonthlyReportResult,
  MonthSummary,
} from "../repositories/monthly-report-repository.ts";

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
