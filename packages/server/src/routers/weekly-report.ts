import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  dateWindowEnd,
  dateWindowStart,
  endDateSchema,
  timestampWindowStart,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

/**
 * Classify a week's average daily load relative to chronic baseline.
 * Whoop uses strain zones: restoring (<80% chronic), optimal (80-130%), overreaching (>130%).
 */
export function classifyStrainZone(weekAvgLoad: number, chronicAvgLoad: number): StrainZone {
  if (chronicAvgLoad <= 0) return "optimal";
  const ratio = weekAvgLoad / chronicAvgLoad;
  if (ratio < 0.8) return "restoring";
  if (ratio > 1.3) return "overreaching";
  return "optimal";
}

export const weeklyReportRouter = router({
  /**
   * Weekly Performance Report — mirrors Whoop's Weekly Performance Assessment.
   * Aggregates strain balance, sleep performance, readiness, and key vitals per ISO week.
   */
  report: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ weeks: z.number().min(1).max(52).default(12), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<WeeklyReportResult> => {
      const totalDays = input.weeks * 7 + 28; // extra for chronic baseline

      // Fetch weekly aggregates: training load, sleep, readiness, vitals
      const weeklyReportRowSchema = z.object({
        week_start: dateStringSchema,
        total_hours: z.coerce.number(),
        activity_count: z.coerce.number(),
        avg_daily_load: z.coerce.number(),
        avg_sleep_min: z.coerce.number().nullable(),
        avg_resting_hr: z.coerce.number().nullable(),
        avg_hrv: z.coerce.number().nullable(),
        chronic_avg_load: z.coerce.number(),
        prev_3wk_avg_sleep: z.coerce.number().nullable(),
      });

      const rows = await executeWithSchema(
        ctx.db,
        weeklyReportRowSchema,
        sql`WITH date_series AS (
              SELECT generate_series(
                ${dateWindowStart(input.endDate, totalDays)},
                ${dateWindowEnd(input.endDate)},
                '1 day'::interval
              )::date AS date
            ),
            per_activity AS (
              SELECT
                (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 3600.0 AS hours,
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * asum.avg_hr / NULLIF(asum.max_hr, 0) AS load
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND (asum.started_at AT TIME ZONE ${ctx.timezone})::date >= ${dateWindowStart(input.endDate, totalDays)}
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
            ),
            daily_training AS (
              SELECT date, SUM(hours) AS hours, COUNT(*) AS count, SUM(load) AS load
              FROM per_activity
              GROUP BY date
            ),
            daily AS (
              SELECT
                ds.date,
                COALESCE(dt.hours, 0) AS hours,
                COALESCE(dt.count, 0) AS count,
                COALESCE(dt.load, 0) AS load
              FROM date_series ds
              LEFT JOIN daily_training dt ON dt.date = ds.date
            ),
            sleep_daily AS (
              SELECT
                (started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(input.endDate, totalDays)}
            ),
            metrics_daily AS (
              SELECT
                date,
                resting_hr,
                hrv
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, totalDays)}
            ),
            weekly AS (
              SELECT
                date_trunc('week', d.date)::date AS week_start,
                SUM(d.hours) AS total_hours,
                SUM(d.count)::int AS activity_count,
                AVG(d.load) AS avg_daily_load,
                AVG(sl.duration_minutes) AS avg_sleep_min,
                AVG(m.resting_hr) AS avg_resting_hr,
                AVG(m.hrv) AS avg_hrv
              FROM daily d
              LEFT JOIN sleep_daily sl ON sl.date = d.date
              LEFT JOIN metrics_daily m ON m.date = d.date
              GROUP BY date_trunc('week', d.date)
              ORDER BY week_start ASC
            )
            SELECT
              week_start::text,
              total_hours,
              activity_count,
              avg_daily_load,
              avg_sleep_min,
              avg_resting_hr,
              avg_hrv,
              AVG(avg_daily_load) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS chronic_avg_load,
              AVG(avg_sleep_min) OVER (ORDER BY week_start ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING) AS prev_3wk_avg_sleep
            FROM weekly`,
      );

      const parsed = rows.map((row) => {
        const avgDailyLoad = Number(row.avg_daily_load) || 0;
        const chronicAvgLoad = Number(row.chronic_avg_load) || 0;
        const avgSleepMin = row.avg_sleep_min != null ? Number(row.avg_sleep_min) : 0;
        const prev3wkSleep = row.prev_3wk_avg_sleep != null ? Number(row.prev_3wk_avg_sleep) : null;

        return {
          weekStart: row.week_start,
          trainingHours: Math.round(Number(row.total_hours) * 10) / 10,
          activityCount: Number(row.activity_count),
          strainZone: classifyStrainZone(avgDailyLoad, chronicAvgLoad),
          avgDailyLoad: Math.round(avgDailyLoad * 10) / 10,
          avgSleepMinutes: Math.round(avgSleepMin),
          sleepPerformancePct:
            prev3wkSleep != null && prev3wkSleep > 0
              ? Math.round((avgSleepMin / prev3wkSleep) * 100)
              : 100,
          avgReadiness: 0, // filled below
          avgRestingHr:
            row.avg_resting_hr != null ? Math.round(Number(row.avg_resting_hr) * 10) / 10 : null,
          avgHrv: row.avg_hrv != null ? Math.round(Number(row.avg_hrv) * 10) / 10 : null,
        } satisfies WeekSummary;
      });

      // Only return the requested number of weeks
      const cutoffWeeks = parsed.slice(-input.weeks);
      const current = cutoffWeeks.length > 0 ? (cutoffWeeks[cutoffWeeks.length - 1] ?? null) : null;
      const history = cutoffWeeks.slice(0, -1);

      return { current, history };
    }),
});
