import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import {
  computeRecommendedBedtime,
  computeSleepPerformance,
  type SleepPerformanceResult,
} from "@dofek/scoring/sleep-performance";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateAccessPredicate } from "../billing/entitlement.ts";
import {
  buildSleepNeedComputation,
  type SleepNeedComputation,
  type SleepNeedResult,
  type SleepNeedV2,
  type SleepNight,
  sleepNeedV1Schema,
  sleepNeedV2Schema,
  toSleepNeedV1,
  toSleepNeedV2,
} from "../contracts/sleep-need-contract.ts";
import { dateWindowEnd, dateWindowStart, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClickHouseSleepNight,
  fetchDailySleepPerformanceNights,
  fetchSleepNights,
} from "../repositories/clickhouse-sleep-repository.ts";
import { StressRepository } from "../repositories/stress-repository.ts";
import { type AuthenticatedContext, CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((leftValue, rightValue) => leftValue - rightValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 !== 0) return sortedValues[middleIndex] ?? null;
  const leftValue = sortedValues[middleIndex - 1];
  const rightValue = sortedValues[middleIndex];
  if (leftValue == null || rightValue == null) return null;
  return (leftValue + rightValue) / 2;
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

function computeLatestSleepConsistency(
  sleepRows: Array<Pick<ClickHouseSleepNight, "date" | "started_at" | "ended_at">>,
  sleepDate: string,
  timezone: string,
): number | null {
  const scheduleRows = sleepRows
    .flatMap((row) => {
      const endedAt = row.ended_at;
      const bedtimeHour = hourInTimezone(row.started_at, timezone);
      const waketimeHour = endedAt ? hourInTimezone(endedAt, timezone) : null;
      if (bedtimeHour == null || waketimeHour == null) return [];
      return [{ date: row.date, bedtimeHour, waketimeHour }];
    })
    .sort((leftRow, rightRow) => leftRow.date.localeCompare(rightRow.date));

  let latestIndex = -1;
  for (let rowIndex = scheduleRows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    if (scheduleRows[rowIndex]?.date === sleepDate) {
      latestIndex = rowIndex;
      break;
    }
  }
  if (latestIndex < 0) return null;

  const windowRows = scheduleRows.slice(Math.max(0, latestIndex - 13), latestIndex + 1);
  if (windowRows.length < 7) return null;

  return computeSleepConsistencyScore(
    populationStddev(windowRows.map((row) => row.bedtimeHour)),
    populationStddev(windowRows.map((row) => row.waketimeHour)),
  );
}

function lowStressScore(stressScore: number | null | undefined): number | null {
  if (stressScore == null) return null;
  return Math.round(Math.min(Math.max(100 - (stressScore / 3) * 100, 0), 100));
}

export interface SleepPerformanceInfo extends SleepPerformanceResult {
  actualMinutes: number;
  neededMinutes: number;
  efficiency: number;
  recommendedBedtime: string;
  /** Date of the sleep session (wake-up date), for freshness checking */
  sleepDate: string;
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
}

export type { SleepNeedResult, SleepNeedV2, SleepNight };

/**
 * Whoop's sleep need formula:
 * Total need = baseline + strain debt + (accumulated debt recovery * 0.25)
 *
 * Baseline: personalized from 90-day average of nights where next-day readiness was above median.
 * Strain debt: extra sleep proportional to yesterday's training load.
 * Debt recovery: 25% of accumulated debt paid back per night.
 */
async function calculateSleepNeed(
  ctx: AuthenticatedContext,
  endDate: string,
): Promise<SleepNeedComputation> {
  const sensorStore = requireSensorStore(ctx.sensorStore, "sleepNeed.calculate");

  // Yesterday's training load comes from the compact ClickHouse activity-load read model.
  // The sleep + HRV part of the query stays in PG; we inject the load value as a parameter.
  const loadRows = await sensorStore.query(
    z.object({ load: z.coerce.number().nullable() }),
    `SELECT
          sumOrNull(daily_load) AS load
        FROM analytics.daily_strain FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          AND toDate(toTimeZone(toDateTime(date), {timezone:String})) =
            toDate({endDate:String}) - INTERVAL 1 DAY
        `,
    { userId: ctx.userId, timezone: ctx.timezone, endDate },
  );
  const yesterdayLoadFromCh = loadRows[0]?.load ?? null;

  const sleepRows = await fetchSleepNights({
    sensorStore,
    userId: ctx.userId,
    timezone: ctx.timezone,
    endDate,
    days: 90,
    accessWindow: ctx.accessWindow,
    order: "asc",
  });

  const hrvRows = await executeWithSchema(
    ctx.db,
    z.object({ date: dateStringSchema, hrv: z.coerce.number().nullable() }),
    sql`
            SELECT
              date::text AS date,
              hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
              AND date > ${dateWindowStart(endDate, 90)}
              AND date <= ${dateWindowEnd(endDate)}
              AND hrv IS NOT NULL
              ${dateAccessPredicate(ctx.accessWindow, sql`date`)}
            ORDER BY date ASC`,
  );

  const hrvByDate = new Map(hrvRows.map((row) => [row.date, row.hrv]));
  const nextDayHrvValues = sleepRows
    .map((sleepRow) => hrvByDate.get(addDays(sleepRow.date, 1)) ?? null)
    .filter((value): value is number => value != null);
  const medianHrv = median(nextDayHrvValues);

  const nights = sleepRows.map((sleepRow) => {
    const nextDayHrv = hrvByDate.get(addDays(sleepRow.date, 1)) ?? null;
    return {
      date: sleepRow.date,
      duration_minutes: sleepRow.duration_minutes,
      next_day_hrv: nextDayHrv,
      median_hrv: medianHrv,
      good_recovery: medianHrv != null && nextDayHrv != null && nextDayHrv >= medianHrv,
      yesterday_load: yesterdayLoadFromCh,
    };
  });

  // Calculate personalized baseline from nights that preceded good recovery
  const goodNightDurations = nights
    .filter((night) => night.good_recovery)
    .map((night) => night.duration_minutes)
    .filter((duration): duration is number => duration != null && duration > 0);
  const baselineMinutes =
    goodNightDurations.length >= 7
      ? Math.round(
          goodNightDurations.reduce((sum, duration) => sum + duration, 0) /
            goodNightDurations.length,
        )
      : 480; // default to 8 hours if insufficient data

  const yesterdayLoad = yesterdayLoadFromCh ?? 0;

  // Strain debt: ~1 minute extra sleep per 5 units of load, capped at 60 min
  const strainDebtMinutes = Math.min(60, Math.round(yesterdayLoad / 5));

  // Accumulated sleep debt over last 14 nights
  const last14 = nights.slice(-14);
  const debtObservedNightCount = last14.filter((night) => night.duration_minutes != null).length;
  let accumulatedDebt = 0;
  for (const night of last14) {
    if (night.duration_minutes == null) continue;
    const deficit = baselineMinutes - night.duration_minutes;
    if (deficit > 0) accumulatedDebt += deficit;
  }

  // Build calendar of last 7 completed nights (endDate-7 through endDate-1).
  // Today is excluded because tonight's sleep hasn't happened yet.
  // Use UTC noon to avoid any timezone-related date shifts with toISOString()
  const nightsByDate = new Map(nights.map((n) => [n.date, n]));
  const calendarDates: string[] = [];
  const anchorDate = new Date(`${endDate}T12:00:00Z`);
  for (let i = 7; i >= 1; i--) {
    const calendarDay = new Date(anchorDate);
    calendarDay.setUTCDate(calendarDay.getUTCDate() - i);
    calendarDates.push(calendarDay.toISOString().slice(0, 10));
  }

  // Map all 7 calendar dates to nights (null for missing)
  const recentNights: SleepNight[] = calendarDates.map((date) => {
    const night = nightsByDate.get(date);
    if (night?.duration_minutes != null) {
      const actual = night.duration_minutes;
      const sleepRow = sleepRows.find((row) => row.date === date);
      return {
        date,
        actualMinutes: Math.round(actual),
        neededMinutes: baselineMinutes,
        debtMinutes: Math.max(0, Math.round(baselineMinutes - actual)),
        providerId: sleepRow?.provider_id ?? null,
        sourceName: sleepRow?.source_name ?? null,
        sourceProviders: sleepRow?.source_providers ?? [],
      };
    }
    return {
      date,
      actualMinutes: null,
      neededMinutes: baselineMinutes,
      debtMinutes: null,
      providerId: null,
      sourceName: null,
      sourceProviders: [],
    };
  });

  const yesterdayDate = new Date(`${endDate}T12:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
  return buildSleepNeedComputation({
    baselineMinutes,
    strainDebtMinutes,
    accumulatedDebtMinutes: Math.round(accumulatedDebt),
    baselineQualifyingNightCount: goodNightDurations.length,
    debtObservedNightCount,
    recentNights,
    hasPreviousNight: sleepRows.some(
      (sleepRow) => sleepRow.date === yesterdayStr && sleepRow.duration_minutes != null,
    ),
    hasYesterdayLoad: yesterdayLoadFromCh != null,
  });
}

export const sleepNeedRouter = router({
  /**
   * Legacy Sleep Need Calculator. Kept for installed clients.
   */
  calculate: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ endDate: endDateSchema }))
    .output(sleepNeedV1Schema.nullable())
    .query(async ({ ctx, input }): Promise<SleepNeedResult | null> => {
      return toSleepNeedV1(await calculateSleepNeed(ctx, input.endDate));
    }),

  /**
   * Availability-aware Sleep Need Calculator for current clients.
   */
  calculateV2: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    keyVersion: "sleep-need-metadata-v1",
  })
    .input(z.object({ endDate: endDateSchema }))
    .output(sleepNeedV2Schema)
    .query(async ({ ctx, input }): Promise<SleepNeedV2> => {
      return toSleepNeedV2(await calculateSleepNeed(ctx, input.endDate));
    }),

  /**
   * Sleep performance score for last night: how well did you sleep relative to need.
   * Returns score (0-100), tier (Peak/Perform/Get By/Low), and recommended bedtime.
   */
  performance: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<SleepPerformanceInfo | null> => {
      const tz = ctx.timezone ?? "UTC";
      const sensorStore = requireSensorStore(ctx.sensorStore, "sleepNeed.performance");
      const performanceRows = await fetchDailySleepPerformanceNights({
        sensorStore,
        userId: ctx.userId,
        endDate: input.endDate,
        days: 90,
        accessWindow: ctx.accessWindow,
        queryOptions: { priority: "dashboard" },
      });
      const lastSleep = performanceRows.at(-1) ?? null;
      if (!lastSleep || lastSleep.duration_minutes == null || lastSleep.efficiency_pct == null) {
        return null;
      }

      const actualMinutes = lastSleep.duration_minutes;
      const efficiency = lastSleep.efficiency_pct;

      const durations = performanceRows
        .filter((row) => row.date !== lastSleep.date)
        .map((row) => row.duration_minutes)
        .filter((duration): duration is number => duration != null);
      const neededMinutes =
        durations.length > 0
          ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
          : 480;

      const consistency = computeLatestSleepConsistency(performanceRows, lastSleep.date, tz);
      const stressResult = await new StressRepository(
        ctx.db,
        ctx.userId,
        tz,
        sensorStore,
        ctx.accessWindow,
      ).getStressScores(90, input.endDate, { priority: "dashboard" });
      const stressScore =
        stressResult.daily.find((stressRow) => stressRow.date === lastSleep.date)?.stressScore ??
        null;
      const lowStress = lowStressScore(stressScore);
      const hasAdditionalComponents = consistency != null || lowStress != null;

      const result = computeSleepPerformance(
        actualMinutes,
        neededMinutes,
        efficiency,
        hasAdditionalComponents ? { consistency, lowStress } : undefined,
      );
      const recommendedBedtime = computeRecommendedBedtime("07:00", Math.round(neededMinutes));
      return {
        ...result,
        actualMinutes,
        neededMinutes: Math.round(neededMinutes),
        efficiency,
        recommendedBedtime,
        sleepDate: lastSleep.date,
        providerId: lastSleep.provider_id,
        sourceName: lastSleep.source_name,
        sourceProviders: lastSleep.source_providers,
      };
    }),
});
