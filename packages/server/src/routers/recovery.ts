import { type RecordLocalTimeContext, recordLocalHour } from "@dofek/format/record-local-time";
import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import { baselineReadinessComponents, StrainScore } from "@dofek/scoring/scoring";
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

export type SleepAnalyticsDataState =
  | { status: "available" }
  | { status: "missing"; reason: string; nextAction: string };

export interface SleepNightlyRow {
  date: string;
  /** Time in bed (includes awake time). Use for stage-percentage math. */
  durationMinutes: number | null;
  /** Actual time asleep (deep + REM + light). Use for display and sleep debt. */
  sleepMinutes: number | null;
  deepPct: number | null;
  remPct: number | null;
  lightPct: number | null;
  awakePct: number | null;
  efficiency: number | null;
  stagingAvailable: boolean;
  rollingAvgDuration: number | null;
  durationState: SleepAnalyticsDataState;
  sleepState: SleepAnalyticsDataState;
  stageState: SleepAnalyticsDataState;
  startedAt: string;
  endedAt: string | null;
  localTimeContext: RecordLocalTimeContext;
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
  selectedSessionId: string | null;
  overlappingSessions: SleepOverlappingSession[];
}

export interface SleepOverlappingSession {
  sessionId: string;
  providerId: string;
  sourceName: string | null;
  sourceProviders: string[];
  localTimeContext: RecordLocalTimeContext;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
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
        const localTimeContext = {
          timezone: row.timezone,
          startUtcOffsetMinutes: row.start_utc_offset_minutes,
          endUtcOffsetMinutes: row.end_utc_offset_minutes,
          source: row.local_time_source,
        };
        const bedtimeHour = recordLocalHour(row.started_at, localTimeContext, "start");
        const waketimeHour = endedAt ? recordLocalHour(endedAt, localTimeContext, "end") : null;
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
      const availableState: SleepAnalyticsDataState = { status: "available" };
      const missingDurationState: SleepAnalyticsDataState = {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      };
      const missingStagesState: SleepAnalyticsDataState = {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      };
      const hasStageMinutes = (row: (typeof rows)[number]): boolean =>
        row.staging_available &&
        row.deep_minutes != null &&
        row.rem_minutes != null &&
        row.light_minutes != null &&
        row.awake_minutes != null;
      const computeSleepMinutes = (row: (typeof rows)[number]): number | null => {
        if (row.provider_id !== "apple_health") {
          return row.duration_minutes;
        }
        if (!row.staging_available) {
          return null;
        }
        if (
          row.deep_minutes == null &&
          row.rem_minutes == null &&
          row.light_minutes == null &&
          row.awake_minutes == null
        ) {
          return null;
        }
        return (row.deep_minutes ?? 0) + (row.rem_minutes ?? 0) + (row.light_minutes ?? 0);
      };

      const nightly = rows.map((row, rowIndex) => {
        const durationMinutes = row.duration_minutes;
        const sleepMinutes = computeSleepMinutes(row);
        const durationState = durationMinutes == null ? missingDurationState : availableState;
        const stageState = hasStageMinutes(row) ? availableState : missingStagesState;
        const sleepState =
          sleepMinutes != null
            ? availableState
            : durationMinutes == null
              ? missingDurationState
              : missingStagesState;
        const windowRows = rows.slice(Math.max(0, rowIndex - 6), rowIndex + 1);
        const rollingDurations = windowRows
          .map(computeSleepMinutes)
          .filter((duration): duration is number => duration != null);
        const rollingAvgDuration =
          rollingDurations.length > 0
            ? rollingDurations.reduce((sum, duration) => sum + duration, 0) /
              rollingDurations.length
            : null;
        const stagePercent = (minutes: number | null): number | null =>
          hasStageMinutes(row) && durationMinutes != null && durationMinutes > 0 && minutes != null
            ? Math.round((minutes / durationMinutes) * 1000) / 10
            : null;
        return {
          date: row.date,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          localTimeContext: {
            timezone: row.timezone,
            startUtcOffsetMinutes: row.start_utc_offset_minutes,
            endUtcOffsetMinutes: row.end_utc_offset_minutes,
            source: row.local_time_source,
          },
          providerId: row.provider_id,
          sourceName: row.source_name,
          sourceProviders: row.source_providers,
          selectedSessionId: row.selected_session_id,
          overlappingSessions: row.overlapping_sessions.map((session) => ({
            sessionId: session.session_id,
            providerId: session.provider_id,
            sourceName: session.source_name,
            sourceProviders: session.source_providers,
            localTimeContext: {
              timezone: session.timezone,
              startUtcOffsetMinutes: session.start_utc_offset_minutes,
              endUtcOffsetMinutes: session.end_utc_offset_minutes,
              source: session.local_time_source,
            },
            startedAt: session.started_at,
            endedAt: session.ended_at,
            durationMinutes: session.duration_minutes,
          })),
          durationMinutes,
          sleepMinutes,
          deepPct: stagePercent(row.deep_minutes),
          remPct: stagePercent(row.rem_minutes),
          lightPct: stagePercent(row.light_minutes),
          awakePct: stagePercent(row.awake_minutes),
          efficiency: row.efficiency_pct == null ? null : Math.round(row.efficiency_pct * 10) / 10,
          stagingAvailable: row.staging_available,
          rollingAvgDuration:
            rollingAvgDuration == null ? null : Math.round(rollingAvgDuration * 10) / 10,
          durationState,
          sleepState,
          stageState,
        };
      });

      // Compute 14-day sleep debt vs personalized target (using actual sleep time)
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const last14 = nightly.slice(-14);
      const targetMinutes = effective.sleepTarget.minutes;
      const measuredLast14 = last14.filter(
        (night): night is typeof night & { sleepMinutes: number } => night.sleepMinutes != null,
      );
      const measuredSleepMinutes = nightly
        .map((night) => night.sleepMinutes)
        .filter((minutes): minutes is number => minutes != null);
      const sleepDebt =
        measuredLast14.length > 0
          ? Math.round(
              measuredLast14.reduce((debt, night) => {
                return debt + (targetMinutes - night.sleepMinutes);
              }, 0),
            )
          : null;
      const averageSleepMinutes =
        measuredSleepMinutes.length > 0
          ? Math.round(
              (measuredSleepMinutes.reduce((sum, minutes) => sum + minutes, 0) /
                measuredSleepMinutes.length) *
                10,
            ) / 10
          : null;
      const measuredEfficiencies = nightly
        .map((night) => night.efficiency)
        .filter((efficiency): efficiency is number => efficiency != null);
      const averageEfficiencyPercent =
        measuredEfficiencies.length > 0
          ? Math.round(
              (measuredEfficiencies.reduce((sum, efficiency) => sum + efficiency, 0) /
                measuredEfficiencies.length) *
                10,
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
        hrv_z_score: z.coerce.number().nullable(),
        resting_hr_z_score: z.coerce.number().nullable(),
        respiratory_rate_z_score: z.coerce.number().nullable(),
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
          hrv_z_score,
          resting_hr_z_score,
          respiratory_rate_z_score,
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

        const components: ReadinessComponents = baselineReadinessComponents({
          hrvZScore: metrics.hrv_z_score,
          restingHeartRateZScore: metrics.resting_hr_z_score,
          respiratoryRateZScore: metrics.respiratory_rate_z_score,
          sleepEfficiency: metrics.efficiency_pct != null ? Number(metrics.efficiency_pct) : null,
        });

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
