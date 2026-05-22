import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import { StrainScore, zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { selectRecentDailyLoad } from "@dofek/training/training";
import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateAccessPredicate } from "../billing/entitlement.ts";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import {
  dateWindowEnd,
  dateWindowStart,
  dateWindowStartString,
  endDateSchema,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  fetchLatestSleepNight,
  fetchSleepNights,
} from "../repositories/clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hourInTimezone(timestamp: string, timezone: string): number | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour + minute / 60;
}

function populationStddev(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

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
  currentStrainSource?: "heart_rate" | "activity" | "none";
  currentPhysiologyLoad?: number | null;
  progressPercent: number;
  zone: "Push" | "Maintain" | "Recovery";
  explanation: string;
  dailyLoad?: number;
  acuteLoad?: number;
  chronicLoad?: number;
  workloadRatio?: number | null;
  readinessScore?: number;
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
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.sleepConsistency");
      const today = new Date().toISOString().slice(0, 10);
      const rows = (
        await fetchSleepNights({
          sensorStore,
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: today,
          days: queryDays,
          accessWindow: ctx.accessWindow,
          order: "asc",
        })
      ).flatMap((row) => {
        const endedAt = row.ended_at;
        const bedtimeHour = hourInTimezone(row.started_at, ctx.timezone);
        const waketimeHour = endedAt ? hourInTimezone(endedAt, ctx.timezone) : null;
        if (bedtimeHour == null || waketimeHour == null) return [];
        return [{ date: row.date, bedtimeHour, waketimeHour }];
      });

      const cutoffDate = addDays(today, -input.days);
      return rows
        .map((row, rowIndex) => {
          const windowRows = rows.slice(Math.max(0, rowIndex - 13), rowIndex + 1);
          const bedStddev = populationStddev(windowRows.map((windowRow) => windowRow.bedtimeHour));
          const wakeStddev = populationStddev(
            windowRows.map((windowRow) => windowRow.waketimeHour),
          );

          const consistencyScore =
            windowRows.length >= 7 ? computeSleepConsistencyScore(bedStddev, wakeStddev) : null;

          return {
            date: row.date,
            bedtimeHour: Math.round(row.bedtimeHour * 100) / 100,
            waketimeHour: Math.round(row.waketimeHour * 100) / 100,
            rollingBedtimeStddev: bedStddev != null ? Math.round(bedStddev * 100) / 100 : null,
            rollingWaketimeStddev: wakeStddev != null ? Math.round(wakeStddev * 100) / 100 : null,
            consistencyScore,
          };
        })
        .filter((row) => row.date > cutoffDate);
    }),

  /**
   * Rolling 7-day coefficient of variation of HRV (stddev/mean * 100).
   * Fetches extra warmup rows to ensure window functions have data from day 1.
   */
  hrvVariability: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
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
                AND date > ${dateWindowStart(input.endDate, queryDays)}
                AND date <= ${dateWindowEnd(input.endDate)}
                AND hrv IS NOT NULL
                ${dateAccessPredicate(ctx.accessWindow, sql`date`)}
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
            WHERE date > ${dateWindowStart(input.endDate, input.days)}
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
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.workloadRatio");
      const queryDays = input.days + 28;
      const workloadRowSchema = z.object({
        date: z.string(),
        daily_load: z.coerce.number(),
        acute_load: z.coerce.number(),
        chronic_load: z.coerce.number(),
        workload_ratio: z.coerce.number().nullable(),
      });
      const rows = await sensorStore.query(
        workloadRowSchema,
        `WITH per_activity AS (
          SELECT
            toDate(toTimeZone(started_at, {timezone:String})) AS date,
            dateDiff('second', started_at, ended_at) / 60.0
              * avg_hr
              / nullIf(toFloat64(max_hr), 0) AS load
          FROM analytics.activity_summary
          WHERE user_id = {userId:UUID}
            AND toDate(toTimeZone(started_at, {timezone:String})) >= toDate({windowStart:String})
            AND ended_at IS NOT NULL
            AND avg_hr IS NOT NULL
        ),
        activity_load AS (
          SELECT date, sum(load) AS daily_load
          FROM per_activity
          GROUP BY date
        ),
        date_series AS (
          SELECT toDate({windowStart:String}) + INTERVAL number DAY AS date
          FROM numbers(toUInt64({totalDays:Int32}) + 1)
        ),
        daily AS (
          SELECT ds.date AS date, coalesce(al.daily_load, 0) AS daily_load
          FROM date_series ds
          LEFT JOIN activity_load al ON al.date = ds.date
        ),
        with_windows AS (
          SELECT
            date,
            daily_load,
            sum(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
            avg(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg,
            count() OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_count
          FROM daily
        )
        SELECT
          toString(with_windows.date) AS date,
          with_windows.daily_load AS daily_load,
          with_windows.acute_load AS acute_load,
          with_windows.chronic_load_avg * 7 AS chronic_load,
          if(with_windows.chronic_load_avg > 0 AND with_windows.chronic_count = 28,
             with_windows.acute_load / (with_windows.chronic_load_avg * 7),
             NULL) AS workload_ratio
        FROM with_windows
        WHERE with_windows.date > toDate({outputWindowStart:String})
        ORDER BY date ASC`,
        {
          userId: ctx.userId,
          timezone: ctx.timezone,
          windowStart: dateWindowStartString(input.endDate, queryDays),
          totalDays: queryDays,
          outputWindowStart: dateWindowStartString(input.endDate, input.days),
        },
      );

      const timeSeries = rows.map((row) => {
        const dailyLoad = Math.round(Number(row.daily_load) * 10) / 10;
        const acuteLoad = Math.round(Number(row.acute_load) * 10) / 10;
        return {
          date: row.date,
          dailyLoad,
          strain: StrainScore.fromRawLoad(dailyLoad).value,
          acuteLoad,
          chronicLoad: Math.round(Number(row.chronic_load) * 10) / 10,
          workloadRatio:
            row.workload_ratio != null ? Math.round(Number(row.workload_ratio) * 100) / 100 : null,
        };
      });

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
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.sleepAnalytics");
      const endDate = new Date().toISOString().slice(0, 10);
      const rows = await fetchSleepNights({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        days: input.days,
        accessWindow: ctx.accessWindow,
        order: "asc",
      });

      // Apple Health reports duration as in-bed time, so derive actual sleep
      // from stage minutes. Other providers already exclude awake time from
      // duration_minutes, so use duration directly to preserve their accounting.
      const computeSleepMinutes = (row: (typeof rows)[number]) => {
        const durationMinutes = row.duration_minutes ?? 0;
        if (row.provider_id !== "apple_health") return durationMinutes;
        const hasStages =
          row.deep_minutes != null || row.rem_minutes != null || row.light_minutes != null;
        if (!hasStages) return durationMinutes;
        return (row.deep_minutes ?? 0) + (row.rem_minutes ?? 0) + (row.light_minutes ?? 0);
      };

      const nightly = rows.map((row, rowIndex) => {
        const durationMinutes = row.duration_minutes ?? 0;
        const sleepMinutes = computeSleepMinutes(row);
        const windowRows = rows.slice(Math.max(0, rowIndex - 6), rowIndex + 1);
        const rollingDurations = windowRows.map(computeSleepMinutes);
        const rollingAvgDuration =
          rollingDurations.reduce((sum, duration) => sum + duration, 0) / rollingDurations.length;
        return {
          date: row.date,
          durationMinutes,
          sleepMinutes,
          deepPct:
            durationMinutes > 0
              ? Math.round(((row.deep_minutes ?? 0) / durationMinutes) * 1000) / 10
              : 0,
          remPct:
            durationMinutes > 0
              ? Math.round(((row.rem_minutes ?? 0) / durationMinutes) * 1000) / 10
              : 0,
          lightPct:
            durationMinutes > 0
              ? Math.round(((row.light_minutes ?? 0) / durationMinutes) * 1000) / 10
              : 0,
          awakePct:
            durationMinutes > 0
              ? Math.round(((row.awake_minutes ?? 0) / durationMinutes) * 1000) / 10
              : 0,
          efficiency: Math.round((row.efficiency_pct ?? 0) * 10) / 10,
          rollingAvgDuration: Math.round(rollingAvgDuration * 10) / 10,
        };
      });

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
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.readinessScore");
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: queryDays,
      });
      const [metricsRows, sleepRows] = await Promise.all([
        executeWithSchema(
          ctx.db,
          readinessRowSchema,
          sql`WITH ${restingHeartRateCte},
          metrics_with_baselines AS (
              SELECT
                dm.date::text AS date,
                dm.hrv,
                drhr.resting_hr,
                dm.respiratory_rate_avg AS respiratory_rate,
                AVG(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean_30d,
                STDDEV_POP(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd_30d,
                AVG(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean_30d,
                STDDEV_POP(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd_30d,
                AVG(dm.respiratory_rate_avg) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean_30d,
                STDDEV_POP(dm.respiratory_rate_avg) OVER (ORDER BY dm.date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd_30d
              FROM fitness.v_daily_metrics dm
	              LEFT JOIN resting_heart_rate drhr
	                ON drhr.date = dm.date
              WHERE dm.user_id = ${ctx.userId}
                AND dm.date > ${dateWindowStart(input.endDate, queryDays)}
                AND dm.date <= ${dateWindowEnd(input.endDate)}
                ${dateAccessPredicate(ctx.accessWindow, sql`dm.date`)}
            )
            SELECT
              m.date AS date,
              m.hrv,
              m.resting_hr,
              m.respiratory_rate,
              m.hrv_mean_30d,
              m.hrv_sd_30d,
              m.rhr_mean_30d,
              m.rhr_sd_30d,
              m.rr_mean_30d,
              m.rr_sd_30d,
              NULL::real AS efficiency_pct
            FROM metrics_with_baselines m
            ORDER BY date ASC`,
        ),
        fetchSleepNights({
          sensorStore,
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: input.endDate,
          days: queryDays,
          accessWindow: ctx.accessWindow,
          order: "asc",
        }),
      ]);
      const combinedByDate = new Map(
        metricsRows.map((row) => [
          row.date,
          {
            ...row,
            efficiency_pct:
              sleepRows.find((sleepRow) => sleepRow.date === row.date)?.efficiency_pct ?? null,
          },
        ]),
      );
      for (const sleepRow of sleepRows) {
        if (combinedByDate.has(sleepRow.date)) continue;
        combinedByDate.set(sleepRow.date, {
          date: sleepRow.date,
          hrv: null,
          resting_hr: null,
          respiratory_rate: null,
          hrv_mean_30d: null,
          hrv_sd_30d: null,
          rhr_mean_30d: null,
          rhr_sd_30d: null,
          rr_mean_30d: null,
          rr_sd_30d: null,
          efficiency_pct: sleepRow.efficiency_pct,
        });
      }
      const combinedRows = [...combinedByDate.values()].sort((leftRow, rightRow) =>
        leftRow.date.localeCompare(rightRow.date),
      );
      const cutoffDate = new Date(input.endDate);
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      const cutoffStr = cutoffDate.toISOString().split("T")[0] ?? "";

      const results: ReadinessRow[] = [];

      for (const metrics of combinedRows) {
        if (metrics.date <= cutoffStr) continue;
        if (metrics.date > input.endDate) continue;

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
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.strainTarget");
      const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: input.days,
      });
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
	          WITH ${restingHeartRateCte},
            metric_dates AS (
            SELECT dm.date
            FROM fitness.v_daily_metrics dm
            WHERE dm.user_id = ${ctx.userId}
              AND dm.date > ${dateWindowStart(input.endDate, input.days)}
              AND dm.date <= ${dateWindowEnd(input.endDate)}
              ${dateAccessPredicate(ctx.accessWindow, sql`dm.date`)}
            UNION
	            SELECT drhr.date
	            FROM resting_heart_rate drhr
	            WHERE drhr.date > ${dateWindowStart(input.endDate, input.days)}
	              AND drhr.date <= ${dateWindowEnd(input.endDate)}
	              ${dateAccessPredicate(ctx.accessWindow, sql`drhr.date`)}
          )
          SELECT dates.date, drhr.resting_hr, dm.hrv, dm.spo2_avg, dm.respiratory_rate_avg
          FROM metric_dates dates
          LEFT JOIN fitness.v_daily_metrics dm
            ON dm.user_id = ${ctx.userId}
           AND dm.date = dates.date
	          LEFT JOIN resting_heart_rate drhr
	            ON drhr.date = dates.date
          ORDER BY dates.date DESC
          LIMIT 1
        `,
      );

      // Get daily loads for ACWR (from ClickHouse analytics.activity_summary)
      const loads = await sensorStore.query(
        z.object({
          date: z.string(),
          daily_load: z.coerce.number(),
        }),
        `SELECT
          toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
          sum(dateDiff('second', started_at, ended_at) / 60.0
              * avg_hr / nullIf(toFloat64(max_hr), 0)) AS daily_load
        FROM analytics.activity_summary
        WHERE user_id = {userId:UUID}
          AND toDate(toTimeZone(started_at, {timezone:String})) >= toDate({windowStart:String})
          AND ended_at IS NOT NULL
          AND avg_hr IS NOT NULL
        GROUP BY toDate(toTimeZone(started_at, {timezone:String}))
        ORDER BY date ASC`,
        {
          userId: ctx.userId,
          timezone: ctx.timezone,
          windowStart: dateWindowStartString(input.endDate, input.days),
        },
      );

      // Compute readiness if we have metrics
      let readinessScore = 50; // default moderate
      const readinessMetrics = readinessRows[0];
      if (readinessMetrics) {
        const params = getEffectiveParams(await loadPersonalizedParams(ctx.db, ctx.userId));
        const latestSleep = await fetchLatestSleepNight({
          sensorStore,
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: input.endDate,
          accessWindow: ctx.accessWindow,
        });

        // Use sleep efficiency as a proxy for sleep score, default 62 for others
        const sleepEff = latestSleep?.efficiency_pct ?? null;
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
      let acuteLoadTotal = 0;
      let chronicLoad = 0;

      for (const row of loads) {
        const daysAgo = Math.floor(
          (new Date(today).getTime() - new Date(row.date).getTime()) / 86400000,
        );
        if (daysAgo < acuteWindow) acuteLoadTotal += row.daily_load;
        if (daysAgo < chronicWindow) chronicLoad += row.daily_load;
      }
      const acuteLoad = acuteLoadTotal / acuteWindow;
      chronicLoad /= chronicWindow;

      const target = computeStrainTarget(readinessScore, chronicLoad, acuteLoad);
      const todayLoad = loads.find((row) => row.date === today)?.daily_load ?? 0;
      const currentStrain = await computeCurrentStrain({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: today,
        fallbackActivityLoad: todayLoad,
      });
      const roundedCurrentStrain = Math.round(currentStrain.currentStrain * 10) / 10;
      const roundedAcuteLoad = Math.round(acuteLoad * 10) / 10;
      const roundedChronicLoad = Math.round(chronicLoad * 10) / 10;
      const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;

      return {
        targetStrain: target.targetStrain,
        currentStrain: roundedCurrentStrain,
        currentStrainSource: currentStrain.currentStrainSource,
        currentPhysiologyLoad: currentStrain.currentPhysiologyLoad,
        progressPercent:
          target.targetStrain > 0
            ? Math.round((roundedCurrentStrain / target.targetStrain) * 100)
            : 0,
        zone: target.zone,
        explanation: target.explanation,
        dailyLoad: Math.round(todayLoad * 10) / 10,
        acuteLoad: roundedAcuteLoad,
        chronicLoad: roundedChronicLoad,
        workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
        readinessScore,
      };
    }),
});
