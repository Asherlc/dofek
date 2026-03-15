import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface HrvVariabilityRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

export interface WorkloadRatioRow {
  date: string;
  dailyLoad: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export interface SleepNightlyRow {
  date: string;
  durationMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
  rollingAvgDuration: number | null;
}

export interface SleepAnalyticsResult {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
}

export interface SleepConsistencyRow {
  date: string;
  bedtimeHour: number;
  waketimeHour: number;
  rollingBedtimeStddev: number | null;
  rollingWaketimeStddev: number | null;
  consistencyScore: number | null;
}

export interface ReadinessComponents {
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  loadBalanceScore: number;
}

export interface ReadinessRow {
  date: string;
  readinessScore: number;
  components: ReadinessComponents;
}

export const recoveryRouter = router({
  /**
   * Sleep schedule consistency: stddev of bedtime and wake time over rolling 14-day windows.
   * Lower stddev = more consistent schedule. Consistency score 0-100 based on how
   * tight the schedule is (< 30 min stddev = 100, > 90 min = 0).
   */
  sleepConsistency: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SleepConsistencyRow[]> => {
      const queryDays = input.days + 14;
      const consistencyRowSchema = z.object({
        date: z.string(),
        bedtime_hour: z.coerce.number(),
        waketime_hour: z.coerce.number(),
        rolling_bedtime_stddev: z.coerce.number().nullable(),
        rolling_waketime_stddev: z.coerce.number().nullable(),
        window_count: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        consistencyRowSchema,
        sql`WITH nightly AS (
              SELECT
                started_at::date AS date,
                EXTRACT(HOUR FROM started_at) + EXTRACT(MINUTE FROM started_at) / 60.0 AS bedtime_hour,
                EXTRACT(HOUR FROM ended_at) + EXTRACT(MINUTE FROM ended_at) / 60.0 AS waketime_hour
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              ORDER BY started_at ASC
            )
            SELECT
              date::text,
              bedtime_hour,
              waketime_hour,
              STDDEV_POP(bedtime_hour) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS rolling_bedtime_stddev,
              STDDEV_POP(waketime_hour) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS rolling_waketime_stddev,
              COUNT(*) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS window_count
            FROM nightly
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );

      return rows.map((row) => {
        const bedStddev =
          row.rolling_bedtime_stddev != null ? Number(row.rolling_bedtime_stddev) : null;
        const wakeStddev =
          row.rolling_waketime_stddev != null ? Number(row.rolling_waketime_stddev) : null;

        // Consistency score: average of bed/wake stddev mapped to 0-100
        // < 0.5 hr stddev = 100, > 1.5 hr stddev = 0
        let consistencyScore: number | null = null;
        if (bedStddev != null && wakeStddev != null && Number(row.window_count) >= 7) {
          const avgStddevHours = (bedStddev + wakeStddev) / 2;
          const score = Math.max(0, Math.min(100, (1 - (avgStddevHours - 0.5) / 1.0) * 100));
          consistencyScore = Math.round(score);
        }

        return {
          date: row.date,
          bedtimeHour: Math.round(Number(row.bedtime_hour) * 100) / 100,
          waketimeHour: Math.round(Number(row.waketime_hour) * 100) / 100,
          rollingBedtimeStddev: bedStddev != null ? Math.round(bedStddev * 100) / 100 : null,
          rollingWaketimeStddev: wakeStddev != null ? Math.round(wakeStddev * 100) / 100 : null,
          consistencyScore,
        };
      });
    }),

  /**
   * Rolling 7-day coefficient of variation of HRV (stddev/mean * 100).
   * Fetches extra warmup rows to ensure window functions have data from day 1.
   */
  hrvVariability: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<HrvVariabilityRow[]> => {
      const queryDays = input.days + 7;
      const hrvRowSchema = z.object({
        date: z.string(),
        hrv: z.coerce.number().nullable(),
        rolling_mean: z.coerce.number().nullable(),
        rolling_cv: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        hrvRowSchema,
        sql`WITH daily AS (
              SELECT
                date,
                hrv
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${queryDays}::int
                AND hrv IS NOT NULL
              ORDER BY date ASC
            )
            SELECT
              date::text AS date,
              hrv,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_mean,
              CASE
                WHEN AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) > 0
                  AND COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) = 7
                THEN (STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
                      / AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)) * 100
                ELSE NULL
              END AS rolling_cv
            FROM daily
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );

      return rows.map((row) => ({
        date: row.date,
        hrv: row.hrv != null ? Math.round(Number(row.hrv) * 10) / 10 : null,
        rollingCoefficientOfVariation:
          row.rolling_cv != null ? Math.round(Number(row.rolling_cv) * 100) / 100 : null,
        rollingMean:
          row.rolling_mean != null ? Math.round(Number(row.rolling_mean) * 10) / 10 : null,
      }));
    }),

  /**
   * Acute:Chronic Workload Ratio.
   * Reads from activity_summary rollup for per-activity load.
   * Daily load = sum of (duration_min * avg_hr / max_hr) per activity.
   * Acute = 7-day sum, Chronic = 28-day average of daily load.
   */
  workloadRatio: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<WorkloadRatioRow[]> => {
      const queryDays = input.days + 28;
      const workloadRowSchema = z.object({
        date: z.string(),
        daily_load: z.coerce.number(),
        acute_load: z.coerce.number(),
        chronic_load: z.coerce.number(),
        workload_ratio: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        workloadRowSchema,
        sql`WITH date_series AS (
              SELECT generate_series(
                CURRENT_DATE - ${queryDays}::int,
                CURRENT_DATE,
                '1 day'::interval
              )::date AS date
            ),
            per_activity AS (
              SELECT
                asum.started_at::date AS date,
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * asum.avg_hr
                  / NULLIF(asum.max_hr, 0) AS load
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND asum.started_at::date >= CURRENT_DATE - ${queryDays}::int
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
            ),
            activity_load AS (
              SELECT date, SUM(load) AS daily_load
              FROM per_activity
              GROUP BY date
            ),
            daily AS (
              SELECT
                ds.date,
                COALESCE(al.daily_load, 0) AS daily_load
              FROM date_series ds
              LEFT JOIN activity_load al ON al.date = ds.date
            ),
            with_windows AS (
              SELECT
                date,
                daily_load,
                SUM(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
                AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg,
                COUNT(*) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_count
              FROM daily
            )
            SELECT
              date::text AS date,
              daily_load,
              acute_load,
              chronic_load_avg * 7 AS chronic_load,
              CASE
                WHEN chronic_load_avg > 0 AND chronic_count = 28
                THEN acute_load / (chronic_load_avg * 7)
                ELSE NULL
              END AS workload_ratio
            FROM with_windows
            WHERE date > CURRENT_DATE - ${input.days}::int
            ORDER BY date ASC`,
      );

      return rows.map((row) => ({
        date: row.date,
        dailyLoad: Math.round(Number(row.daily_load) * 10) / 10,
        acuteLoad: Math.round(Number(row.acute_load) * 10) / 10,
        chronicLoad: Math.round(Number(row.chronic_load) * 10) / 10,
        workloadRatio:
          row.workload_ratio != null ? Math.round(Number(row.workload_ratio) * 100) / 100 : null,
      }));
    }),

  /**
   * Sleep analytics: stage percentages, rolling avg duration, sleep debt.
   * Excludes naps. Sleep debt = cumulative deficit vs 8hr target over 14 days.
   */
  sleepAnalytics: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SleepAnalyticsResult> => {
      const sleepRowSchema = z.object({
        date: z.string(),
        duration_minutes: z.coerce.number(),
        deep_pct: z.coerce.number(),
        rem_pct: z.coerce.number(),
        light_pct: z.coerce.number(),
        awake_pct: z.coerce.number(),
        efficiency: z.coerce.number(),
        rolling_avg_duration: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        sleepRowSchema,
        sql`WITH nightly AS (
              SELECT
                started_at::date AS date,
                duration_minutes,
                deep_minutes,
                rem_minutes,
                light_minutes,
                awake_minutes,
                efficiency_pct,
                CASE WHEN duration_minutes > 0 THEN deep_minutes::real / duration_minutes * 100 ELSE 0 END AS deep_pct,
                CASE WHEN duration_minutes > 0 THEN rem_minutes::real / duration_minutes * 100 ELSE 0 END AS rem_pct,
                CASE WHEN duration_minutes > 0 THEN light_minutes::real / duration_minutes * 100 ELSE 0 END AS light_pct,
                CASE WHEN duration_minutes > 0 THEN awake_minutes::real / duration_minutes * 100 ELSE 0 END AS awake_pct
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              ORDER BY started_at ASC
            )
            SELECT
              date::text AS date,
              duration_minutes,
              deep_pct,
              rem_pct,
              light_pct,
              awake_pct,
              efficiency_pct AS efficiency,
              AVG(duration_minutes) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_avg_duration
            FROM nightly
            ORDER BY date ASC`,
      );

      const nightly = rows.map((row) => ({
        date: row.date,
        durationMinutes: Number(row.duration_minutes),
        deepPct: Math.round(Number(row.deep_pct) * 10) / 10,
        remPct: Math.round(Number(row.rem_pct) * 10) / 10,
        lightPct: Math.round(Number(row.light_pct) * 10) / 10,
        awakePct: Math.round(Number(row.awake_pct) * 10) / 10,
        efficiency: Math.round(Number(row.efficiency) * 10) / 10,
        rollingAvgDuration:
          row.rolling_avg_duration != null
            ? Math.round(Number(row.rolling_avg_duration) * 10) / 10
            : null,
      }));

      // Compute 14-day sleep debt vs 8hr (480 min) target
      const last14 = nightly.slice(-14);
      const targetMinutes = 480;
      const sleepDebt = last14.reduce((debt, night) => {
        return debt + (targetMinutes - night.durationMinutes);
      }, 0);

      return {
        nightly,
        sleepDebt: Math.round(sleepDebt),
      };
    }),

  /**
   * Composite readiness score 0-100 from:
   *   HRV vs 60d baseline (40%), resting HR vs baseline (20%),
   *   sleep efficiency (20%), ACWR balance (20%).
   * Reads ACWR from activity_summary rollup instead of raw metric_stream.
   */
  readinessScore: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ ctx, input }): Promise<ReadinessRow[]> => {
      const queryDays = input.days + 60;

      // Fetch HRV + resting HR baselines, sleep efficiency, and ACWR in one query
      const readinessRowSchema = z.object({
        date: z.string(),
        hrv: z.coerce.number().nullable(),
        resting_hr: z.coerce.number().nullable(),
        hrv_mean_60d: z.coerce.number().nullable(),
        hrv_sd_60d: z.coerce.number().nullable(),
        rhr_mean_60d: z.coerce.number().nullable(),
        rhr_sd_60d: z.coerce.number().nullable(),
        efficiency_pct: z.coerce.number().nullable(),
        acwr: z.coerce.number().nullable(),
      });
      const combinedRows = await executeWithSchema(
        ctx.db,
        readinessRowSchema,
        sql`WITH metrics_with_baselines AS (
              SELECT
                date::text AS date,
                hrv,
                resting_hr,
                AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_mean_60d,
                STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_sd_60d,
                AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_mean_60d,
                STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_sd_60d
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${queryDays}::int
            ),
            sleep_eff AS (
              SELECT DISTINCT ON (COALESCE(ended_at, started_at + interval '8 hours')::date)
                COALESCE(ended_at, started_at + interval '8 hours')::date::text AS date,
                efficiency_pct
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              ORDER BY COALESCE(ended_at, started_at + interval '8 hours')::date, started_at DESC
            ),
            date_series AS (
              SELECT generate_series(
                CURRENT_DATE - ${queryDays}::int,
                CURRENT_DATE,
                '1 day'::interval
              )::date AS date
            ),
            per_activity AS (
              SELECT
                asum.started_at::date AS date,
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * asum.avg_hr
                  / NULLIF(asum.max_hr, 0) AS load
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND asum.started_at::date >= CURRENT_DATE - ${queryDays}::int
                AND asum.ended_at IS NOT NULL
                AND asum.avg_hr IS NOT NULL
            ),
            activity_load AS (
              SELECT date, SUM(load) AS daily_load
              FROM per_activity
              GROUP BY date
            ),
            daily AS (
              SELECT
                ds.date,
                COALESCE(al.daily_load, 0) AS daily_load
              FROM date_series ds
              LEFT JOIN activity_load al ON al.date = ds.date
            ),
            acwr_daily AS (
              SELECT
                date::text AS date,
                CASE
                  WHEN AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) * 7 > 0
                  THEN SUM(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
                       / (AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) * 7)
                  ELSE NULL
                END AS acwr
              FROM daily
            )
            SELECT
              m.date,
              m.hrv,
              m.resting_hr,
              m.hrv_mean_60d,
              m.hrv_sd_60d,
              m.rhr_mean_60d,
              m.rhr_sd_60d,
              s.efficiency_pct,
              ac.acwr
            FROM metrics_with_baselines m
            LEFT JOIN sleep_eff s ON s.date = m.date
            LEFT JOIN acwr_daily ac ON ac.date = m.date
            ORDER BY m.date ASC`,
      );
      const combined = combinedRows;

      // Map z-score to 0-100 (z=0 -> 50, clamped)
      function zScoreToScore(zScore: number): number {
        const score = 50 + zScore * 15;
        return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
      }

      // ACWR: optimal is 1.0, penalize deviation
      function acwrToScore(acwr: number | null): number {
        if (acwr == null) return 50;
        const deviation = Math.abs(acwr - 1.0);
        // 0 deviation = 100, 1.0 deviation = 0
        return Math.max(0, Math.min(100, Math.round((1 - deviation) * 100)));
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().split("T")[0] ?? "";

      const results: ReadinessRow[] = [];

      for (const metrics of combined) {
        if (metrics.date <= cutoffStr) continue;

        // HRV score: higher HRV = better (positive z = good)
        let hrvScore = 50;
        if (
          metrics.hrv != null &&
          metrics.hrv_mean_60d != null &&
          metrics.hrv_sd_60d != null &&
          Number(metrics.hrv_sd_60d) > 0
        ) {
          const zHrv =
            (Number(metrics.hrv) - Number(metrics.hrv_mean_60d)) / Number(metrics.hrv_sd_60d);
          hrvScore = zScoreToScore(zHrv);
        }

        // Resting HR score: lower HR = better (negative z = good, so invert)
        let restingHrScore = 50;
        if (
          metrics.resting_hr != null &&
          metrics.rhr_mean_60d != null &&
          metrics.rhr_sd_60d != null &&
          Number(metrics.rhr_sd_60d) > 0
        ) {
          const zRhr =
            (Number(metrics.resting_hr) - Number(metrics.rhr_mean_60d)) /
            Number(metrics.rhr_sd_60d);
          restingHrScore = zScoreToScore(-zRhr);
        }

        // Sleep efficiency score: direct mapping (0-100 already)
        const efficiency = metrics.efficiency_pct != null ? Number(metrics.efficiency_pct) : null;
        const sleepScore =
          efficiency != null ? Math.max(0, Math.min(100, Math.round(efficiency))) : 50;

        // Load balance score from ACWR
        const acwr = metrics.acwr != null ? Number(metrics.acwr) : null;
        const loadBalanceScore = acwrToScore(acwr);

        const readinessScore = Math.round(
          hrvScore * 0.4 + restingHrScore * 0.2 + sleepScore * 0.2 + loadBalanceScore * 0.2,
        );

        results.push({
          date: metrics.date,
          readinessScore: Math.max(0, Math.min(100, readinessScore)),
          components: {
            hrvScore: Math.round(hrvScore),
            restingHrScore: Math.round(restingHrScore),
            sleepScore,
            loadBalanceScore: Math.round(loadBalanceScore),
          },
        });
      }

      return results;
    }),
});
