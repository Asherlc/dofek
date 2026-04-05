import {
  computeRecommendedBedtime,
  computeSleepPerformance,
  type SleepPerformanceResult,
} from "@dofek/scoring/sleep-performance";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { sleepNightDate } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const sleepNeedRowSchema = z.object({
  date: dateStringSchema,
  duration_minutes: z.coerce.number(),
  next_day_hrv: z.coerce.number().nullable(),
  median_hrv: z.coerce.number().nullable(),
  good_recovery: z.coerce.boolean(),
  yesterday_load: z.coerce.number(),
});

const lastSleepRowSchema = z.object({
  duration_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
  sleep_date: z.string(),
});

const baselineRowSchema = z.object({
  avg_duration: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Data access and computation for sleep need analysis and performance scoring.
 *
 * Implements a Whoop-style sleep need formula:
 * Total need = baseline + strain debt + (accumulated debt recovery * 0.25)
 */
export class SleepNeedRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async calculate(endDate: string): Promise<SleepNeedResult> {
    const nights = await executeWithSchema(
      this.#db,
      sleepNeedRowSchema,
      sql`WITH sleep_raw AS (
            SELECT
              ${sleepNightDate(this.#timezone)} AS date,
              COALESCE(duration_minutes, EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)::int AS duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at > ${timestampWindowStart(endDate, 90)}
          ),
          sleep_nights AS (
            SELECT DISTINCT ON (date) date, duration_minutes
            FROM sleep_raw
            ORDER BY date, duration_minutes DESC NULLS LAST
          ),
          daily_hrv AS (
            SELECT
              date,
              hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, 90)}
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
            WHERE asum.user_id = ${this.#userId}
              AND (asum.started_at AT TIME ZONE ${this.#timezone})::date = ${sql`${endDate}::date - 1`}
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

    return this.#computeSleepNeed(nights, endDate);
  }

  async getPerformance(endDate: string): Promise<SleepPerformanceInfo | null> {
    const sleepRows = await executeWithSchema(
      this.#db,
      lastSleepRowSchema,
      sql`
        SELECT duration_minutes, efficiency_pct,
          (COALESCE(ended_at, started_at + interval '8 hours') AT TIME ZONE ${this.#timezone})::date::text AS sleep_date
        FROM fitness.v_sleep
        WHERE user_id = ${this.#userId}
          AND is_nap = false
        ORDER BY started_at DESC
        LIMIT 1
      `,
    );

    const lastSleep = sleepRows[0];
    if (!lastSleep || lastSleep.duration_minutes == null) {
      return null;
    }

    const actualMinutes = lastSleep.duration_minutes;
    const efficiency = lastSleep.efficiency_pct ?? 85;

    const baselineRows = await executeWithSchema(
      this.#db,
      baselineRowSchema,
      sql`
        WITH raw_sleep AS (
          SELECT ${sleepNightDate(this.#timezone)} AS date, duration_minutes
          FROM fitness.v_sleep
          WHERE user_id = ${this.#userId}
            AND is_nap = false
            AND started_at > ${timestampWindowStart(endDate, 90)}
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
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  #computeSleepNeed(
    nights: z.infer<typeof sleepNeedRowSchema>[],
    endDate: string,
  ): SleepNeedResult {
    // Calculate personalized baseline from nights that preceded good recovery
    const goodNights = nights.filter((night) => night.good_recovery && night.duration_minutes > 0);
    const baselineMinutes =
      goodNights.length >= 7
        ? Math.round(
            goodNights.reduce((sum, night) => sum + Number(night.duration_minutes), 0) /
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

    // Build calendar of last 7 dates (endDate-6 through endDate)
    const nightsByDate = new Map(nights.map((night) => [night.date, night]));
    const calendarDates: string[] = [];
    const anchorDate = new Date(`${endDate}T12:00:00Z`);
    for (let index = 6; index >= 0; index--) {
      const calendarDay = new Date(anchorDate);
      calendarDay.setUTCDate(calendarDay.getUTCDate() - index);
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
    const yesterdayDate = new Date(`${endDate}T12:00:00Z`);
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
  }
}
