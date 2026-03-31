import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type WeeklyStressRow,
} from "@dofek/recovery/stress";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStart } from "../lib/date-window.ts";
import { sleepDedupCte, vitalsBaselineCte } from "../lib/sql-fragments.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";

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
export class StressRepository extends BaseRepository {
  async getStressScores(days: number, endDate: string): Promise<StressResult> {
    const queryDays = days + BASELINE_LOOKBACK_DAYS;

    const rows = await this.query(
      rawRowSchema,
      sql`WITH ${vitalsBaselineCte(this.userId, endDate, days, 60)},
          ${sleepDedupCte(this.userId, this.timezone, endDate, queryDays)}
          SELECT
            m.date::text,
            m.hrv,
            m.resting_hr,
            m.hrv_mean_60d,
            m.hrv_stddev_60d AS hrv_sd_60d,
            m.resting_hr_mean_60d AS rhr_mean_60d,
            m.resting_hr_stddev_60d AS rhr_sd_60d,
            sd.efficiency_pct
          FROM vitals_baseline m
          LEFT JOIN sleep_deduped sd ON sd.sleep_date = m.date
          WHERE m.date > ${dateWindowStart(endDate, days)}
          ORDER BY m.date ASC`,
    );

    const storedParams = await loadPersonalizedParams(this.db, this.userId);
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
