import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { WeeklyReportRepository } from "../repositories/weekly-report-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export { classifyStrainZone } from "../repositories/weekly-report-repository.ts";

/** Strain balance category based on ACWR-like load distribution */
export type StrainZone = "restoring" | "optimal" | "overreaching";

export interface WeekSummary {
  /** ISO week start date (Monday) */
  weekStart: string;
  /** Total training hours */
  trainingHours: number;
  /** Number of activities */
  activityCount: number;
  /** Strain balance zone based on the week's average daily load vs chronic baseline */
  strainZone: StrainZone;
  /** Average daily load for the week */
  avgDailyLoad: number;
  /** Average sleep duration (minutes) */
  avgSleepMinutes: number;
  /** Sleep performance: avg sleep vs 3-week rolling avg (percentage) */
  sleepPerformancePct: number;
  /** Average readiness score for the week */
  avgReadiness: number;
  /** Average resting HR */
  avgRestingHr: number | null;
  /** Average HRV */
  avgHrv: number | null;
}

export interface WeeklyReportResult {
  /** Current week's summary */
  current: WeekSummary | null;
  /** Previous weeks for comparison */
  history: WeekSummary[];
}

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
