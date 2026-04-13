import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import { StrainScore, zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { selectRecentDailyLoad } from "@dofek/training/training";
import * as Sentry from "@sentry/node";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  dateWindowEnd,
  dateWindowStart,
  endDateSchema,
  timestampWindowStart,
} from "../lib/date-window.ts";
import { sleepNightDate } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { TrainingRepository } from "../repositories/training-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { ReadinessComponents, ReadinessWeights };

export interface HrvVariabilityRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

export interface WorkloadRatioRow {
  date: string;
  dailyLoad: number;
  strain: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export interface WorkloadRatioResult {
  timeSeries: WorkloadRatioRow[];
  displayedStrain: number;
  displayedDate: string | null;
}

export interface SleepNightlyRow {
  date: string;
  /** Time in bed (includes awake time). Use for stage-percentage math. */
  durationMinutes: number;
  /** Actual time asleep (deep + REM + light). Use for display and sleep debt. */
  sleepMinutes: number;
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

export interface ReadinessRow {
  date: string;
  readinessScore: number;
  components: ReadinessComponents;
  weights: ReadinessWeights;
}

export interface StrainTargetResult {
  targetStrain: number;
  currentStrain: number;
  progressPercent: number;
  zone: "Push" | "Maintain" | "Recovery";
  explanation: string;
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
        date: dateStringSchema,
        bedtime_hour: z.coerce.number(),
        waketime_hour: z.coerce.number(),
        rolling_bedtime_stddev: z.coerce.number().nullable(),
        rolling_waketime_stddev: z.coerce.number().nullable(),
        window_count: z.coerce.number(),
      });
      const tz = ctx.timezone;
      const rows = await executeWithSchema(
        ctx.db,
        consistencyRowSchema,
        sql`WITH raw_sleep AS (
              SELECT
                ${sleepNightDate(tz)} AS date,
                EXTRACT(HOUR FROM started_at AT TIME ZONE ${tz}) + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${tz}) / 60.0 AS bedtime_hour,
                EXTRACT(HOUR FROM ended_at AT TIME ZONE ${tz}) + EXTRACT(MINUTE FROM ended_at AT TIME ZONE ${tz}) / 60.0 AS waketime_hour,
                duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
            ),
            nightly AS (
              SELECT DISTINCT ON (date) date, bedtime_hour, waketime_hour
              FROM raw_sleep
              ORDER BY date, duration_minutes DESC NULLS LAST
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

        const consistencyScore =
          Number(row.window_count) >= 7
            ? computeSleepConsistencyScore(bedStddev, wakeStddev)
            : null;

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
        date: dateStringSchema,
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
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<WorkloadRatioResult> => {
      const queryDays = input.days + 28;
      const workloadRowSchema = z.object({
        date: dateStringSchema,
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
                ${dateWindowStart(input.endDate, queryDays)},
                ${dateWindowEnd(input.endDate)},
                '1 day'::interval
              )::date AS date
            ),
            per_activity AS (
              SELECT
                (asum.started_at AT TIME ZONE ${ctx.timezone})::date AS date,
                EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                  * asum.avg_hr
                  / NULLIF(asum.max_hr, 0) AS load
              FROM fitness.activity_summary asum
              WHERE asum.user_id = ${ctx.userId}
                AND (asum.started_at AT TIME ZONE ${ctx.timezone})::date >= ${dateWindowStart(input.endDate, queryDays)}
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
            WHERE date > ${dateWindowStart(input.endDate, input.days)}
            ORDER BY date ASC`,
      );

      const timeSeries = rows.map((row) => {
        const dailyLoad = Math.round(Number(row.daily_load) * 10) / 10;
        return {
          date: row.date,
          dailyLoad,
          strain: StrainScore.fromRawLoad(dailyLoad).value,
          acuteLoad: Math.round(Number(row.acute_load) * 10) / 10,
          chronicLoad: Math.round(Number(row.chronic_load) * 10) / 10,
          workloadRatio:
            row.workload_ratio != null ? Math.round(Number(row.workload_ratio) * 100) / 100 : null,
        };
      });

      const hasAnyLoad = timeSeries.some((row) => row.dailyLoad > 0);

      // Self-healing: if all daily loads are 0, the activity_summary
      // materialized view may be stale. Check the base table and refresh.
      // The parallel activityStats/weeklyVolume queries also self-heal,
      // but this ensures strain data is corrected on the same request.
      if (!hasAnyLoad) {
        const repo = new TrainingRepository(ctx.db, ctx.userId, ctx.timezone);
        const baseCount = await repo.baseActivityCount(input.endDate, input.days);
        if (baseCount > 0) {
          logger.warn(
            `[recovery] Stale views detected for user ${ctx.userId}: ` +
              `${baseCount} activities in base table but 0 load in workload ratio. Refreshing.`,
          );
          Sentry.captureMessage("Stale activity materialized views detected (workloadRatio)", {
            level: "warning",
            tags: { userId: ctx.userId },
            extra: { baseCount },
          });
          try {
            await repo.refreshActivityViews();
          } catch (refreshError) {
            Sentry.captureException(refreshError, {
              tags: { userId: ctx.userId, context: "staleViewRefresh" },
            });
          }
          // Views refreshed — data will appear on next pull-to-refresh.
          // Returning stale (zero) data now rather than duplicating the
          // complex SQL for a retry. The training queries that fire in
          // parallel will also benefit from this refresh.
        }
      }

      const displayed = selectRecentDailyLoad(timeSeries);
      return {
        timeSeries,
        displayedStrain: displayed?.strain ?? 0,
        displayedDate: displayed?.date ?? null,
      };
    }),

  /**
   * Sleep analytics: stage percentages, rolling avg duration, sleep debt.
   * Excludes naps. Sleep debt = cumulative deficit vs 8hr target over 14 days.
   */
  sleepAnalytics: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SleepAnalyticsResult> => {
      const sleepRowSchema = z.object({
        date: dateStringSchema,
        duration_minutes: z.coerce.number(),
        sleep_minutes: z.coerce.number(),
        deep_pct: z.coerce.number(),
        rem_pct: z.coerce.number(),
        light_pct: z.coerce.number(),
        awake_pct: z.coerce.number(),
        efficiency: z.coerce.number(),
        rolling_avg_duration: z.coerce.number().nullable(),
      });
      const tz = ctx.timezone;
      const rows = await executeWithSchema(
        ctx.db,
        sleepRowSchema,
        sql`WITH raw_sleep AS (
              SELECT
                ${sleepNightDate(tz)} AS date,
                duration_minutes,
                -- Actual time asleep: for Apple Health, duration = in-bed time,
                -- so derive sleep time from stages. Other providers already exclude awake.
                CASE
                  WHEN provider_id = 'apple_health'
                    AND (deep_minutes IS NOT NULL OR rem_minutes IS NOT NULL OR light_minutes IS NOT NULL)
                    THEN COALESCE(deep_minutes, 0) + COALESCE(rem_minutes, 0) + COALESCE(light_minutes, 0)
                  ELSE duration_minutes
                END AS sleep_minutes,
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
            ),
            nightly AS (
              SELECT DISTINCT ON (date)
                date, duration_minutes, sleep_minutes, deep_minutes, rem_minutes,
                light_minutes, awake_minutes, efficiency_pct, deep_pct, rem_pct, light_pct, awake_pct
              FROM raw_sleep
              ORDER BY date, duration_minutes DESC NULLS LAST
            )
            SELECT
              date::text AS date,
              duration_minutes,
              sleep_minutes,
              deep_pct,
              rem_pct,
              light_pct,
              awake_pct,
              efficiency_pct AS efficiency,
              AVG(sleep_minutes) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_avg_duration
            FROM nightly
            ORDER BY date ASC`,
      );

      const nightly = rows.map((row) => ({
        date: row.date,
        durationMinutes: Number(row.duration_minutes),
        sleepMinutes: Number(row.sleep_minutes),
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

      // Compute 14-day sleep debt vs personalized target (using actual sleep time)
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const last14 = nightly.slice(-14);
      const targetMinutes = effective.sleepTarget.minutes;
      const sleepDebt = last14.reduce((debt, night) => {
        return debt + (targetMinutes - night.sleepMinutes);
      }, 0);

      return {
        nightly,
        sleepDebt: Math.round(sleepDebt),
      };
    }),

  /**
   * Composite readiness score 0-100 modeled after Whoop's recovery algorithm:
   *   HRV vs 30d baseline (50%), resting HR vs baseline (20%),
   *   sleep efficiency (15%), respiratory rate vs baseline (15%).
   * Uses asymmetric sigmoid mapping instead of linear z-score for more natural scaling.
   */
  readinessScore: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<ReadinessRow[]> => {
      // Load personalized readiness weights
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const weights = effective.readinessWeights;

      const queryDays = input.days + 30;

      // Fetch HRV + resting HR + respiratory rate baselines and sleep efficiency
      const readinessRowSchema = z.object({
        date: dateStringSchema,
        hrv: z.coerce.number().nullable(),
        resting_hr: z.coerce.number().nullable(),
        respiratory_rate: z.coerce.number().nullable(),
        hrv_mean_30d: z.coerce.number().nullable(),
        hrv_sd_30d: z.coerce.number().nullable(),
        rhr_mean_30d: z.coerce.number().nullable(),
        rhr_sd_30d: z.coerce.number().nullable(),
        rr_mean_30d: z.coerce.number().nullable(),
        rr_sd_30d: z.coerce.number().nullable(),
        efficiency_pct: z.coerce.number().nullable(),
      });
      const combinedRows = await executeWithSchema(
        ctx.db,
        readinessRowSchema,
        sql`WITH metrics_with_baselines AS (
              SELECT
                date::text AS date,
                hrv,
                resting_hr,
                respiratory_rate_avg AS respiratory_rate,
                AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean_30d,
                STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd_30d,
                AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean_30d,
                STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd_30d,
                AVG(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean_30d,
                STDDEV_POP(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd_30d
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, queryDays)}
            ),
            sleep_eff AS (
              SELECT DISTINCT ON (local_date)
                local_date::text AS date,
                efficiency_pct
              FROM (
                SELECT (COALESCE(ended_at, started_at + interval '8 hours') AT TIME ZONE ${ctx.timezone})::date AS local_date,
                       efficiency_pct, duration_minutes
                FROM fitness.v_sleep
                WHERE user_id = ${ctx.userId}
                  AND is_nap = false
                  AND started_at > ${timestampWindowStart(input.endDate, queryDays)}
              ) sleep_sub
              ORDER BY local_date, duration_minutes DESC NULLS LAST
            )
            SELECT
              m.date,
              m.hrv,
              m.resting_hr,
              m.respiratory_rate,
              m.hrv_mean_30d,
              m.hrv_sd_30d,
              m.rhr_mean_30d,
              m.rhr_sd_30d,
              m.rr_mean_30d,
              m.rr_sd_30d,
              s.efficiency_pct
            FROM metrics_with_baselines m
            LEFT JOIN sleep_eff s ON s.date = m.date
            ORDER BY m.date ASC`,
      );
      const cutoffDate = new Date(input.endDate);
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().split("T")[0] ?? "";

      const results: ReadinessRow[] = [];

      for (const metrics of combinedRows) {
        if (metrics.date <= cutoffStr) continue;

        // HRV score: higher HRV = better recovery (positive z = good)
        let hrvScore = 62;
        if (
          metrics.hrv != null &&
          metrics.hrv_mean_30d != null &&
          metrics.hrv_sd_30d != null &&
          Number(metrics.hrv_sd_30d) > 0
        ) {
          const zHrv =
            (Number(metrics.hrv) - Number(metrics.hrv_mean_30d)) / Number(metrics.hrv_sd_30d);
          hrvScore = zScoreToRecoveryScore(zHrv);
        }

        // Resting HR score: lower HR = better (invert z)
        let restingHrScore = 62;
        if (
          metrics.resting_hr != null &&
          metrics.rhr_mean_30d != null &&
          metrics.rhr_sd_30d != null &&
          Number(metrics.rhr_sd_30d) > 0
        ) {
          const zRhr =
            (Number(metrics.resting_hr) - Number(metrics.rhr_mean_30d)) /
            Number(metrics.rhr_sd_30d);
          restingHrScore = zScoreToRecoveryScore(-zRhr);
        }

        // Sleep efficiency score: direct mapping (0-100 already)
        const efficiency = metrics.efficiency_pct != null ? Number(metrics.efficiency_pct) : null;
        const sleepScore =
          efficiency != null ? Math.max(0, Math.min(100, Math.round(efficiency))) : 62;

        // Respiratory rate score: lower is better (invert z, like RHR)
        let respiratoryRateScore = 62;
        if (
          metrics.respiratory_rate != null &&
          metrics.rr_mean_30d != null &&
          metrics.rr_sd_30d != null &&
          Number(metrics.rr_sd_30d) > 0
        ) {
          const zRr =
            (Number(metrics.respiratory_rate) - Number(metrics.rr_mean_30d)) /
            Number(metrics.rr_sd_30d);
          respiratoryRateScore = zScoreToRecoveryScore(-zRr);
        }

        const components: ReadinessComponents = {
          hrvScore: Math.round(hrvScore),
          restingHrScore: Math.round(restingHrScore),
          sleepScore,
          respiratoryRateScore: Math.round(respiratoryRateScore),
        };

        const readiness = new ReadinessScore(components, weights);

        results.push({
          date: metrics.date,
          readinessScore: readiness.score,
          components: readiness.components,
          weights,
        });
      }

      return results;
    }),

  /**
   * Daily strain target based on current readiness and training loads.
   * Returns a recommended strain level and progress toward it.
   */
  strainTarget: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StrainTargetResult> => {
      // Get readiness score
      const readinessRows = await executeWithSchema(
        ctx.db,
        z.object({
          date: dateStringSchema,
          resting_hr: z.number().nullable(),
          hrv: z.number().nullable(),
          spo2_avg: z.number().nullable(),
          respiratory_rate_avg: z.number().nullable(),
        }),
        sql`
          SELECT date, resting_hr, hrv, spo2_avg, respiratory_rate_avg
          FROM fitness.v_daily_metrics
          WHERE user_id = ${ctx.userId}
          ORDER BY date DESC
          LIMIT 1
        `,
      );

      // Get daily loads for ACWR
      const loads = await executeWithSchema(
        ctx.db,
        z.object({
          date: dateStringSchema,
          daily_load: z.coerce.number(),
        }),
        sql`
          SELECT
            asum.started_at::date::text AS date,
            SUM(
              asum.avg_hr * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0 / 100.0
            ) AS daily_load
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${ctx.userId}
            AND asum.started_at::date >= ${dateWindowStart(input.endDate, input.days)}
            AND asum.ended_at IS NOT NULL
            AND asum.avg_hr IS NOT NULL
          GROUP BY asum.started_at::date
          ORDER BY date ASC
        `,
      );

      // Compute readiness if we have metrics
      let readinessScore = 50; // default moderate
      const readinessMetrics = readinessRows[0];
      if (readinessMetrics) {
        const params = getEffectiveParams(await loadPersonalizedParams(ctx.db, ctx.userId));
        const sleepRows = await executeWithSchema(
          ctx.db,
          z.object({ efficiency_pct: z.number().nullable() }),
          sql`
            WITH raw_sleep AS (
              SELECT ${sleepNightDate(ctx.timezone)} AS date,
                efficiency_pct, started_at, duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
            ),
            nightly AS (
              SELECT DISTINCT ON (date) efficiency_pct, started_at
              FROM raw_sleep
              ORDER BY date DESC, duration_minutes DESC NULLS LAST
            )
            SELECT efficiency_pct FROM nightly ORDER BY started_at DESC LIMIT 1
          `,
        );

        // Use sleep efficiency as a proxy for sleep score, default 62 for others
        const sleepEff = sleepRows[0]?.efficiency_pct ?? null;
        const sleepScore = sleepEff != null ? Math.max(0, Math.min(100, Math.round(sleepEff))) : 62;
        const components: ReadinessComponents = {
          hrvScore:
            readinessMetrics.hrv != null
              ? Math.max(0, Math.min(100, Math.round(readinessMetrics.hrv)))
              : 62,
          restingHrScore:
            readinessMetrics.resting_hr != null
              ? Math.max(0, Math.min(100, 120 - readinessMetrics.resting_hr))
              : 62,
          sleepScore,
          respiratoryRateScore: 62,
        };
        const weights = params.readinessWeights;
        const score = new ReadinessScore(components, weights);
        readinessScore = score.score;
      }

      // Compute acute and chronic loads
      const today = input.endDate;
      const acuteWindow = 7;
      const chronicWindow = 28;
      let acuteLoad = 0;
      let chronicLoad = 0;
      let currentStrain = 0;

      for (const row of loads) {
        const daysAgo = Math.floor(
          (new Date(today).getTime() - new Date(row.date).getTime()) / 86400000,
        );
        if (daysAgo < acuteWindow) acuteLoad += row.daily_load;
        if (daysAgo < chronicWindow) chronicLoad += row.daily_load;
        if (row.date === today) {
          currentStrain = StrainScore.fromRawLoad(row.daily_load).value;
        }
      }
      acuteLoad /= acuteWindow;
      chronicLoad /= chronicWindow;

      const target = computeStrainTarget(readinessScore, chronicLoad, acuteLoad);

      return {
        targetStrain: target.targetStrain,
        currentStrain: Math.round(currentStrain * 10) / 10,
        progressPercent:
          target.targetStrain > 0 ? Math.round((currentStrain / target.targetStrain) * 100) : 0,
        zone: target.zone,
        explanation: target.explanation,
      };
    }),
});
