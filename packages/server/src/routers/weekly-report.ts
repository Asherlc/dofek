import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import {
  WeeklyReportRepository,
  type WeeklyReportResult,
} from "../repositories/weekly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export {
  classifyStrainZone,
  type StrainZone,
  type WeeklyReportResult,
  type WeekSummary,
} from "../repositories/weekly-report-repository.ts";

export const weeklyReportRouter = router({
  /**
   * Weekly Performance Report — mirrors Whoop's Weekly Performance Assessment.
   * Aggregates strain balance, sleep performance, readiness, and key vitals per ISO week.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(1).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<WeeklyReportResult> => {
      const repo = new WeeklyReportRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getReport(input.weeks, input.endDate);
    }),
});
