import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { WeeklyReportRepository } from "../repositories/weekly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type {
  StrainZone,
  WeeklyReportResult,
  WeekSummary,
} from "../repositories/weekly-report-repository.ts";

export const weeklyReportRouter = router({
  /**
   * Weekly Performance Report — mirrors Whoop's Weekly Performance Assessment.
   * Aggregates strain balance, sleep performance, readiness, and key vitals per Sunday-start week.
   */
  report: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ weeks: z.number().min(1).max(52).default(12), endDate: endDateSchema }))
    .query(({ ctx, input }) =>
      new WeeklyReportRepository(ctx.userId, ctx.timezone, ctx.sensorStore).getReport(
        input.weeks,
        input.endDate,
      ),
    ),
});
