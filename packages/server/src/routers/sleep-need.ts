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
import { dateWindowEnd, dateWindowStart, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClickHouseSleepNight,
  fetchLatestSleepNight,
  fetchSleepNights,
} from "../repositories/clickhouse-sleep-repository.ts";
import { StressRepository } from "../repositories/stress-repository.ts";
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
  sleepRows: ClickHouseSleepNight[],
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
      const sensorStore = requireSensorStore(ctx.sensorStore, "sleepNeed.calculate");

      // Yesterday's training load comes from the compact ClickHouse activity-load read model.
      // The sleep + HRV part of the query stays in PG; we inject the load value as a parameter.
      const loadRows = await sensorStore.query(
        z.object({ load: z.coerce.number() }),
        `SELECT
          coalesce(sum(daily_load), 0) AS load
        FROM analytics.daily_strain FINAL
        WHERE user_id = {userId:UUID}
          AND toDate(toTimeZone(toDateTime(date), {timezone:String})) =
            toDate({endDate:String}) - INTERVAL 1 DAY
        `,
        { userId: ctx.userId, timezone: ctx.timezone, endDate: input.endDate },
      );
      const yesterdayLoadFromCh = loadRows[0]?.load ?? 0;

      const sleepRows = await fetchSleepNights({
        sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
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
              AND date > ${dateWindowStart(input.endDate, 90)}
              AND date <= ${dateWindowEnd(input.endDate)}
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
          duration_minutes: sleepRow.duration_minutes ?? 0,
          next_day_hrv: nextDayHrv,
          median_hrv: medianHrv,
          good_recovery: medianHrv != null && nextDayHrv != null && nextDayHrv >= medianHrv,
          yesterday_load: yesterdayLoadFromCh,
        };
      });

      // Calculate personalized baseline from nights that preceded good recovery
      const goodNights = nights.filter((n) => n.good_recovery && n.duration_minutes > 0);
      const baselineMinutes =
        goodNights.length >= 7
          ? Math.round(
              goodNights.reduce((sum, n) => sum + Number(n.duration_minutes), 0) /
                goodNights.length,
            )
          : 480; // default to 8 hours if insufficient data

      const yesterdayLoad = Number(yesterdayLoadFromCh);

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
      const tz = ctx.timezone ?? "UTC";
      const sensorStore = requireSensorStore(ctx.sensorStore, "sleepNeed.performance");
      const lastSleep = await fetchLatestSleepNight({
        sensorStore,
        userId: ctx.userId,
        timezone: tz,
        endDate: input.endDate,
        accessWindow: ctx.accessWindow,
      });
      if (!lastSleep || lastSleep.duration_minutes == null) {
        return null;
      }

      const actualMinutes = lastSleep.duration_minutes;
      const efficiency = lastSleep.efficiency_pct ?? 85;

      const baselineRows = await fetchSleepNights({
        sensorStore,
        userId: ctx.userId,
        timezone: tz,
        endDate: input.endDate,
        days: 90,
        accessWindow: ctx.accessWindow,
        order: "asc",
      });
      const durations = baselineRows
        .map((row) => row.duration_minutes)
        .filter((duration): duration is number => duration != null);
      const neededMinutes =
        durations.length > 0
          ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
          : 480;

      const sleepRowsByDate = new Map(
        [...baselineRows, lastSleep].map((sleepRow) => [sleepRow.date, sleepRow]),
      );
      const consistency = computeLatestSleepConsistency(
        [...sleepRowsByDate.values()],
        lastSleep.date,
        tz,
      );
      const stressResult = await new StressRepository(
        ctx.db,
        ctx.userId,
        tz,
        sensorStore,
        ctx.accessWindow,
      ).getStressScores(90, input.endDate);
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
      };
    }),
});
