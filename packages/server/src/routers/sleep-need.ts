import { sql } from "drizzle-orm";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface SleepNeedResult {
  /** Personalized baseline sleep need in minutes (derived from historical optimum) */
  baselineMinutes: number;
  /** Additional sleep needed due to recent strain */
  strainDebtMinutes: number;
  /** Accumulated sleep debt from recent nights (minutes below need) */
  accumulatedDebtMinutes: number;
  /** Total recommended sleep tonight (minutes) */
  totalNeedMinutes: number;
  /** Last 7 nights: actual vs needed */
  recentNights: SleepNight[];
}

export interface SleepNight {
  date: string;
  actualMinutes: number;
  neededMinutes: number;
  debtMinutes: number;
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
  calculate: cachedProtectedQuery(CacheTTL.SHORT).query(
    async ({ ctx }): Promise<SleepNeedResult> => {
      // Fetch 90 days of sleep + next-day HRV + yesterday's training load in one query
      const rows = await ctx.db.execute(
        sql`WITH sleep_nights AS (
              SELECT
                started_at::date AS date,
                duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - INTERVAL '90 days'
              ORDER BY started_at ASC
            ),
            daily_hrv AS (
              SELECT
                date,
                hrv
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - 90
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
                AND asum.started_at::date = CURRENT_DATE - 1
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

      type RawRow = {
        date: string;
        duration_minutes: number;
        next_day_hrv: number | null;
        median_hrv: number | null;
        good_recovery: boolean;
        yesterday_load: number;
      };

      const nights = rows as unknown as RawRow[];

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

      // Recent nights with debt tracking
      const last7 = nights.slice(-7);
      const recentNights: SleepNight[] = last7.map((n) => {
        const actual = Number(n.duration_minutes);
        const needed = baselineMinutes;
        return {
          date: n.date,
          actualMinutes: Math.round(actual),
          neededMinutes: needed,
          debtMinutes: Math.max(0, Math.round(needed - actual)),
        };
      });

      return {
        baselineMinutes,
        strainDebtMinutes,
        accumulatedDebtMinutes: Math.round(accumulatedDebt),
        totalNeedMinutes,
        recentNights,
      };
    },
  ),
});
