import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type WeeklyStressRow,
} from "@dofek/recovery/stress";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

export type { WeeklyStressRow };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface DailyStressRow {
  date: string;
  stressScore: number;
  hrvDeviation: number | null;
  restingHrDeviation: number | null;
  sleepEfficiency: number | null;
}

export interface StressResult {
  daily: DailyStressRow[];
  weekly: WeeklyStressRow[];
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const rawRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  hrv_mean_60d: z.coerce.number().nullable(),
  hrv_sd_60d: z.coerce.number().nullable(),
  rhr_mean_60d: z.coerce.number().nullable(),
  rhr_sd_60d: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

type RawRow = z.infer<typeof rawRowSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASELINE_LOOKBACK_DAYS = 60;

function computeHrvDeviation(row: RawRow): number | null {
  if (
    row.hrv == null ||
    row.hrv_mean_60d == null ||
    row.hrv_sd_60d == null ||
    Number(row.hrv_sd_60d) <= 0
  ) {
    return null;
  }
  return (
    Math.round(((Number(row.hrv) - Number(row.hrv_mean_60d)) / Number(row.hrv_sd_60d)) * 100) / 100
  );
}

function computeRestingHrDeviation(row: RawRow): number | null {
  if (
    row.resting_hr == null ||
    row.rhr_mean_60d == null ||
    row.rhr_sd_60d == null ||
    Number(row.rhr_sd_60d) <= 0
  ) {
    return null;
  }
  return (
    Math.round(
      ((Number(row.resting_hr) - Number(row.rhr_mean_60d)) / Number(row.rhr_sd_60d)) * 100,
    ) / 100
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access and stress computation for daily/weekly physiological stress. */
export class StressRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async getStressScores(days: number, endDate: string): Promise<StressResult> {
    const queryDays = days + BASELINE_LOOKBACK_DAYS;

    const rows = await executeWithSchema(
      this.#db,
      rawRowSchema,
      sql`WITH metrics AS (
            SELECT
              date,
              hrv,
              resting_hr,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_mean_60d,
              STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_sd_60d,
              AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_mean_60d,
              STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_sd_60d
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, queryDays)}
            ORDER BY date ASC
          ),
          sleep_eff AS (
            SELECT DISTINCT ON (local_date)
              local_date AS date,
              efficiency_pct
            FROM (
              SELECT (started_at AT TIME ZONE ${this.#timezone})::date AS local_date,
                     efficiency_pct, duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${this.#userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(endDate, queryDays)}
            ) sleep_sub
            ORDER BY local_date, duration_minutes DESC NULLS LAST
          )
          SELECT
            m.date::text,
            m.hrv,
            m.resting_hr,
            m.hrv_mean_60d,
            m.hrv_sd_60d,
            m.rhr_mean_60d,
            m.rhr_sd_60d,
            s.efficiency_pct
          FROM metrics m
          LEFT JOIN sleep_eff s ON s.date = m.date
          WHERE m.date > ${dateWindowStart(endDate, days)}
          ORDER BY m.date ASC`,
    );

    // loadPersonalizedParams requires the minimal Database interface from src/db/typed-sql.ts.
    // The Drizzle Database's execute method is structurally compatible, so this cast is safe.
    const storedParams = await loadPersonalizedParams(this.#db, this.#userId);
    const effective = getEffectiveParams(storedParams);

    const daily: DailyStressRow[] = rows.map((row) => {
      const hrvDeviation = computeHrvDeviation(row);
      const restingHrDeviation = computeRestingHrDeviation(row);
      const sleepEfficiency = row.efficiency_pct != null ? Number(row.efficiency_pct) : null;

      const { stressScore } = computeDailyStress(
        { hrvDeviation, restingHrDeviation, sleepEfficiency },
        effective.stressThresholds,
      );

      return {
        date: row.date,
        stressScore,
        hrvDeviation,
        restingHrDeviation,
        sleepEfficiency: sleepEfficiency != null ? Math.round(sleepEfficiency * 10) / 10 : null,
      };
    });

    const weekly = aggregateWeeklyStress(daily);
    const latestScore = daily.length > 0 ? (daily[daily.length - 1]?.stressScore ?? null) : null;
    const trend = computeStressTrend(daily);

    return { daily, weekly, latestScore, trend };
  }
}
