import {
  computeRecommendedBedtime,
  computeSleepPerformance,
  type SleepPerformanceResult,
} from "@dofek/scoring/sleep-performance";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, endDateSchema, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface SleepPerformanceInfo extends SleepPerformanceResult {
  actualMinutes: number;
  neededMinutes: number;
  efficiency: number;
  recommendedBedtime: string;
  /** Date of the sleep session (wake-up date), for freshness checking */
  sleepDate: string;
}

export interface SleepNeedResult {
  /** Personalized baseline sleep need in minutes (derived from historical optimum) */
  baselineMinutes: number;
  /** Additional sleep needed due to recent strain */
  strainDebtMinutes: number;
  /** Accumulated sleep debt from recent nights (minutes below need) */
  accumulatedDebtMinutes: number;
  /** Total recommended sleep tonight (minutes) */
  totalNeedMinutes: number;
  /** Last 7 calendar nights: actual vs needed (null = no data for that night) */
  recentNights: SleepNight[];
  /** Whether yesterday's sleep data is available (required for tonight's recommendation) */
  canRecommend: boolean;
}

export interface SleepNight {
  date: string;
  /** Actual sleep minutes, or null if no data for this night */
  actualMinutes: number | null;
  neededMinutes: number;
  /** Sleep debt for this night, or null if no data */
  debtMinutes: number | null;
}

/**
 * Whoop's sleep need formula:
 * Total need = baseline + strain debt + (accumulated debt recovery * 0.25)
 *
 * Baseline: personalized from 90-day average of nights where next-day readiness was above median.
 * Strain debt: extra sleep proportional to yesterday's training load.
 * Debt recovery: 25% of accumulated debt paid back per night.
 */

export const sleepNeedRouter = router({
  /**
   * Sleep Need Calculator — like Whoop's Sleep Coach.
   * Computes personalized sleep need and accumulated debt.
   */
  calculate: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<SleepNeedResult> => {
      const sleepNeedRowSchema = z.object({
        date: dateStringSchema,
        duration_minutes: z.coerce.number(),
        next_day_hrv: z.coerce.number().nullable(),
        median_hrv: z.coerce.number().nullable(),
        good_recovery: z.coerce.boolean(),
        yesterday_load: z.coerce.number(),
      });

      // Fetch 90 days of sleep + next-day HRV + yesterday's training load in one query.
      // When v_sleep has multiple non-nap sessions per date (e.g. WHOOP + Apple Health
      // that don't overlap >80%), pick the longest per date to avoid arbitrary Map
      // overwrites and inconsistent duration reporting across endpoints.
      const rows = await executeWithSchema(
        ctx.db,
        sleepNeedRowSchema,
        sql`WITH raw_sleep AS (
              SELECT
                (started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                COALESCE(duration_minutes, EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)::int AS duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(input.endDate, 90)}
            ),
            sleep_nights AS (
              SELECT DISTINCT ON (date) date, duration_minutes
              FROM raw_sleep
              ORDER BY date, duration_minutes DESC NULLS LAST
            ),
            daily_hrv AS (
              SELECT
                date,
                hrv
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, 90)}
                AND hrv IS NOT NULL
            ),
            sleep_with_next_hrv AS (
              SELECT
                s.date,
                s.duration_minutes,
                h.hrv AS next_day_hrv
              FROM sleep_nights s
              LEFT JOIN daily_hrv h ON h.date = s.date + 1
            ),
            hrv_median AS (
              SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY next_day_hrv) AS median_hrv
              FROM sleep_with_next_hrv
              WHERE next_day_hrv IS NOT NULL
            ),
            yesterday_load AS (
              SELECT COALESCE(SUM(
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                * asum.avg_hr / NULLIF(asum.max_hr, 0)
              ), 0) AS load
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND (asum.started_at AT TIME ZONE ${ctx.timezone})::date = ${sql`${input.endDate}::date - 1`}
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
            )
            SELECT
              s.date::text,
              s.duration_minutes,
              s.next_day_hrv,
              hm.median_hrv,
              CASE WHEN s.next_day_hrv >= hm.median_hrv THEN true ELSE false END AS good_recovery,
              yl.load AS yesterday_load
            FROM sleep_with_next_hrv s
            CROSS JOIN hrv_median hm
            CROSS JOIN yesterday_load yl
            ORDER BY s.date ASC`,
      );

      const nights = rows;

      // Calculate personalized baseline from nights that preceded good recovery
      const goodNights = nights.filter((n) => n.good_recovery && n.duration_minutes > 0);
      const baselineMinutes =
        goodNights.length >= 7
          ? Math.round(
              goodNights.reduce((sum, n) => sum + Number(n.duration_minutes), 0) /
                goodNights.length,
            )
          : 480; // default to 8 hours if insufficient data

      const yesterdayLoad = Number(nights[0]?.yesterday_load ?? 0);

      // Strain debt: ~1 minute extra sleep per 5 units of load, capped at 60 min
      const strainDebtMinutes = Math.min(60, Math.round(yesterdayLoad / 5));

      // Accumulated sleep debt over last 14 nights
      const last14 = nights.slice(-14);
      let accumulatedDebt = 0;
      for (const night of last14) {
        const deficit = baselineMinutes - Number(night.duration_minutes);
        if (deficit > 0) accumulatedDebt += deficit;
      }

      // Whoop recovers 25% of accumulated debt per night
      const debtRecoveryMinutes = Math.round(accumulatedDebt * 0.25);

      const totalNeedMinutes = baselineMinutes + strainDebtMinutes + debtRecoveryMinutes;

      // Build calendar of last 7 completed nights (endDate-7 through endDate-1).
      // Today is excluded because tonight's sleep hasn't happened yet.
      // Use UTC noon to avoid any timezone-related date shifts with toISOString()
      const nightsByDate = new Map(nights.map((n) => [n.date, n]));
      const calendarDates: string[] = [];
      const anchorDate = new Date(`${input.endDate}T12:00:00Z`);
      for (let i = 7; i >= 1; i--) {
        const calendarDay = new Date(anchorDate);
        calendarDay.setUTCDate(calendarDay.getUTCDate() - i);
        calendarDates.push(calendarDay.toISOString().slice(0, 10));
      }

      // Map all 7 calendar dates to nights (null for missing)
      const recentNights: SleepNight[] = calendarDates.map((date) => {
        const night = nightsByDate.get(date);
        if (night) {
          const actual = Number(night.duration_minutes);
          return {
            date,
            actualMinutes: Math.round(actual),
            neededMinutes: baselineMinutes,
            debtMinutes: Math.max(0, Math.round(baselineMinutes - actual)),
          };
        }
        return {
          date,
          actualMinutes: null,
          neededMinutes: baselineMinutes,
          debtMinutes: null,
        };
      });

      // canRecommend: yesterday's sleep must be present for tonight's recommendation
      const yesterdayDate = new Date(`${input.endDate}T12:00:00Z`);
      yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
      const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
      const canRecommend = nightsByDate.has(yesterdayStr);

      return {
        baselineMinutes,
        strainDebtMinutes,
        accumulatedDebtMinutes: Math.round(accumulatedDebt),
        totalNeedMinutes,
        recentNights,
        canRecommend,
      };
    }),

  /**
   * Sleep performance score for last night: how well did you sleep relative to need.
   * Returns score (0-100), tier (Peak/Perform/Get By/Low), and recommended bedtime.
   */
  performance: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<SleepPerformanceInfo | null> => {
      // Get last night's sleep
      const tz = ctx.timezone;
      const sleepRows = await executeWithSchema(
        ctx.db,
        z.object({
          duration_minutes: z.number().nullable(),
          efficiency_pct: z.number().nullable(),
          sleep_date: z.string(),
        }),
        sql`
          WITH raw_sleep AS (
            SELECT
              (started_at AT TIME ZONE ${tz})::date AS sleep_date_val,
              duration_minutes, efficiency_pct, started_at,
              (COALESCE(ended_at, started_at + interval '8 hours') AT TIME ZONE ${tz})::date::text AS sleep_date
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND is_nap = false
          ),
          nightly AS (
            SELECT DISTINCT ON (sleep_date_val)
              duration_minutes, efficiency_pct, sleep_date, started_at
            FROM raw_sleep
            ORDER BY sleep_date_val DESC, duration_minutes DESC NULLS LAST
          )
          SELECT duration_minutes, efficiency_pct, sleep_date
          FROM nightly ORDER BY started_at DESC LIMIT 1
        `,
      );

      const lastSleep = sleepRows[0];
      if (!lastSleep || lastSleep.duration_minutes == null) {
        return null;
      }

      const actualMinutes = lastSleep.duration_minutes;
      const efficiency = lastSleep.efficiency_pct ?? 85;

      // Get sleep need (reuse the baseline calculation logic)
      // Deduplicate per calendar date to avoid counting multi-provider sessions twice
      const baselineRows = await executeWithSchema(
        ctx.db,
        z.object({ avg_duration: z.coerce.number().nullable() }),
        sql`
          WITH raw_sleep AS (
            SELECT (started_at AT TIME ZONE ${tz})::date AS date, duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND is_nap = false
              AND started_at > ${timestampWindowStart(input.endDate, 90)}
              AND duration_minutes IS NOT NULL
          ),
          nightly AS (
            SELECT DISTINCT ON (date) duration_minutes
            FROM raw_sleep
            ORDER BY date, duration_minutes DESC NULLS LAST
          )
          SELECT AVG(duration_minutes) AS avg_duration FROM nightly
        `,
      );

      const neededMinutes = baselineRows[0]?.avg_duration ?? 480;

      const result = computeSleepPerformance(actualMinutes, neededMinutes, efficiency);
      const recommendedBedtime = computeRecommendedBedtime("07:00", Math.round(neededMinutes));

      return {
        ...result,
        actualMinutes,
        neededMinutes: Math.round(neededMinutes),
        efficiency,
        recommendedBedtime,
        sleepDate: lastSleep.sleep_date,
      };
    }),
});
