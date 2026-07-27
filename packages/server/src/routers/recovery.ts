import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import { StrainScore, zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateAccessPredicate } from "../billing/entitlement.ts";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import {
  clickHouseWindowStartPredicate,
  dateWindowEnd,
  dateWindowStartPredicate,
  endDateSchema,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { fetchSleepNights } from "../repositories/clickhouse-sleep-repository.ts";
import {
  buildStrainTargetResult,
  loadStrainTargetInputs,
  type StrainTargetResult,
  strainTargetResultSchema,
} from "../services/strain-target-result.ts";
import {
  buildWorkloadRatioResult,
  type WorkloadRatioResult,
  type WorkloadRatioRow,
  workloadRatioResultSchema,
} from "../services/workload-ratio.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { StrainTargetResult, WorkloadRatioResult, WorkloadRatioRow };

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
  sleepDebt: number | null;
  averageSleepMinutes: number | null;
  averageEfficiencyPercent: number | null;
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

export const recoveryRouter = router({
  /**
   * Sleep schedule consistency: stddev of bedtime and wake time over rolling 14-day windows.
   * Lower stddev = more consistent schedule. Consistency score 0-100 based on how
   * tight the schedule is (< 30 min stddev = 100, > 90 min = 0).
   */
  sleepConsistency: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
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
        .filter((row) => row.date >= cutoffDate);
    }),

  /**
   * Rolling 7-day coefficient of variation of HRV (stddev/mean * 100).
   * Fetches extra warmup rows to ensure window functions have data from day 1.
   */
  hrvVariability: selectedChartDateRangeQuery(
    "recovery.hrvVariability",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }): Promise<HrvVariabilityRow[]> => {
      const queryRange = range.withWarmupDays(7);
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
                ${dateWindowStartPredicate(sql`date`, input.endDate, queryRange.days)}
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
            WHERE TRUE
              ${dateWindowStartPredicate(sql`date`, input.endDate, range.days)}
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
    },
  ),

  /**
   * Descriptive recent-to-baseline workload ratio.
   * Reads the dbt-owned daily_strain model after its full 28-day window is available.
   * The numerator is the latest 7-day load; the denominator is an equivalent
   * 7-day baseline derived from the latest 28 days.
   */
  workloadRatio: selectedChartDateRangeQuery(
    "recovery.workloadRatio",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }): Promise<WorkloadRatioResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.workloadRatio");
      const workloadRowSchema = z.object({
        date: z.string(),
        daily_load: z.coerce.number(),
        acute_load: z.coerce.number(),
        chronic_load: z.coerce.number(),
        workload_ratio: z.coerce.number().nullable(),
      });
      const accessWindowClause =
        ctx.accessWindow?.kind === "limited"
          ? `AND strain.date >= toDate({accessStartDate:String})
          AND strain.date < toDate({accessEndDateExclusive:String})`
          : "";
      const outputWindowStart = range.windowStartString(input.endDate);
      const rows = await sensorStore.query(
        workloadRowSchema,
        `SELECT
          toString(toDate(toTimeZone(toDateTime(strain.date), {timezone:String}))) AS date,
          strain.daily_load AS daily_load,
          strain.acute_load_7d AS acute_load,
          strain.chronic_load_28d AS chronic_load,
          strain.workload_ratio AS workload_ratio
        FROM analytics.daily_strain AS strain FINAL
        WHERE strain.user_id = {userId:UUID}
          AND strain.is_deleted = 0
          ${clickHouseWindowStartPredicate({
            expression: "strain.date",
            days: range.days,
            paramName: "outputWindowStart",
          })}
          AND strain.date <= toDate({endDate:String})
          ${accessWindowClause}
        ORDER BY date ASC`,
        {
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: input.endDate,
          ...(outputWindowStart === undefined ? {} : { outputWindowStart }),
          ...(ctx.accessWindow?.kind === "limited"
            ? {
                accessStartDate: ctx.accessWindow.startDate,
                accessEndDateExclusive: ctx.accessWindow.endDateExclusive,
              }
            : {}),
        },
        { priority: "dashboard" },
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

      return buildWorkloadRatioResult(timeSeries);
    },
    { outputSchema: workloadRatioResultSchema },
  ),

  /**
   * Sleep analytics: stage percentages, rolling avg duration, sleep debt.
   * Excludes naps. Sleep debt = cumulative deficit vs 8hr target over 14 days.
   */
  sleepAnalytics: selectedChartDateRangeQuery(
    "recovery.sleepAnalytics",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }): Promise<SleepAnalyticsResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.sleepAnalytics");
      const endDate = input.endDate;
      const rows = await fetchSleepNights({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        days: range.days,
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
          rollingDurations.length > 0
            ? rollingDurations.reduce((sum, duration) => sum + duration, 0) /
              rollingDurations.length
            : 0;
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
      const sleepDebt =
        nightly.length > 0
          ? Math.round(
              last14.reduce((debt, night) => {
                return debt + (targetMinutes - night.sleepMinutes);
              }, 0),
            )
          : null;
      const averageSleepMinutes =
        nightly.length > 0
          ? Math.round(
              (nightly.reduce((sum, night) => sum + night.sleepMinutes, 0) / nightly.length) * 10,
            ) / 10
          : null;
      const averageEfficiencyPercent =
        nightly.length > 0
          ? Math.round(
              (nightly.reduce((sum, night) => sum + night.efficiency, 0) / nightly.length) * 10,
            ) / 10
          : null;

      return {
        nightly,
        sleepDebt,
        averageSleepMinutes,
        averageEfficiencyPercent,
      };
    },
  ),

  /**
   * Composite readiness score 0-100 modeled after Whoop's recovery algorithm:
   *   HRV vs 30d baseline (50%), resting HR vs baseline (20%),
   *   sleep efficiency (15%), respiratory rate vs baseline (15%).
   * Uses asymmetric sigmoid mapping instead of linear z-score for more natural scaling.
   */
  readinessScore: selectedChartDateRangeQuery(
    "recovery.readinessScore",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }): Promise<ReadinessRow[]> => {
      // Load personalized readiness weights
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const weights = effective.readinessWeights;

      const queryRange = range.withWarmupDays(30);

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
      const accessWindowClause =
        ctx.accessWindow?.kind === "limited"
          ? `
            AND recovery_inputs.date >= toDate({accessStartDate:String})
            AND recovery_inputs.date < toDate({accessEndDateExclusive:String})`
          : "";
      const windowStart = queryRange.windowStartString(input.endDate);
      const combinedRows = await sensorStore.query(
        readinessRowSchema,
        `SELECT
          toString(recovery_inputs.date) AS date,
          hrv,
          resting_hr,
          respiratory_rate,
          hrv_mean_30d,
          hrv_sd_30d,
          rhr_mean_30d,
          rhr_sd_30d,
          rr_mean_30d,
          rr_sd_30d,
          efficiency_pct
        FROM analytics.daily_recovery AS recovery_inputs FINAL
        WHERE recovery_inputs.user_id = {userId:UUID}
          AND recovery_inputs.is_deleted = 0
          ${clickHouseWindowStartPredicate({
            expression: "recovery_inputs.date",
            days: queryRange.days,
            paramName: "windowStart",
          })}
          AND recovery_inputs.date <= toDate({endDate:String})
          ${accessWindowClause}
        ORDER BY recovery_inputs.date ASC`,
        {
          userId: ctx.userId,
          ...(windowStart === undefined ? {} : { windowStart }),
          endDate: input.endDate,
          ...(ctx.accessWindow?.kind === "limited"
            ? {
                accessStartDate: ctx.accessWindow.startDate,
                accessEndDateExclusive: ctx.accessWindow.endDateExclusive,
              }
            : {}),
        },
        { priority: "dashboard" },
      );
      const cutoffDate = range.windowStartString(input.endDate);

      const results: ReadinessRow[] = [];

      for (const metrics of combinedRows) {
        if (cutoffDate !== undefined && metrics.date <= cutoffDate) continue;
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
    },
  ),

  /**
   * Daily strain target based on current readiness and training loads.
   * Returns a recommended strain level and progress toward it.
   */
  strainTarget: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .output(strainTargetResultSchema.nullable())
    .query(async ({ ctx, input }): Promise<StrainTargetResult | null> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "recovery.strainTarget");
      const params = getEffectiveParams(await loadPersonalizedParams(ctx.db, ctx.userId));
      const { readinessMetrics, loads } = await loadStrainTargetInputs({
        sensorStore,
        userId: ctx.userId,
        endDate: input.endDate,
        days: input.days,
        accessWindow: ctx.accessWindow,
      });

      return buildStrainTargetResult({
        endDate: input.endDate,
        readinessMetrics,
        loads,
        readinessWeights: params.readinessWeights,
      });
    }),
});
