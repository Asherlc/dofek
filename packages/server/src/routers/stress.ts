import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type WeeklyStressRow,
} from "@dofek/recovery/stress";

export type { WeeklyStressRow };

import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, endDateSchema, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface DailyStressRow {
  date: string;
  stressScore: number;
  hrvDeviation: number | null;
  restingHrDeviation: number | null;
  sleepEfficiency: number | null;
}

export interface StressResult {
  daily: DailyStressRow[];
  weekly: ReturnType<typeof aggregateWeeklyStress>;
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

export const stressRouter = router({
  /**
   * Stress Monitor — daily stress scores from HR/HRV deviation against personal baselines.
   * Mirrors Whoop's 0-3 stress scale with cumulative weekly tracking.
   */
  scores: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StressResult> => {
      const queryDays = input.days + 60; // extra for baseline windows

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
      const rows = await executeWithSchema(
        ctx.db,
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
              WHERE user_id = ${ctx.userId}
                AND date > ${dateWindowStart(input.endDate, queryDays)}
              ORDER BY date ASC
            ),
            sleep_eff AS (
              SELECT DISTINCT ON (local_date)
                local_date AS date,
                efficiency_pct
              FROM (
                SELECT (started_at AT TIME ZONE ${ctx.timezone})::date AS local_date,
                       efficiency_pct, duration_minutes
                FROM fitness.v_sleep
                WHERE user_id = ${ctx.userId}
                  AND is_nap = false
                  AND started_at > ${timestampWindowStart(input.endDate, queryDays)}
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
            WHERE m.date > ${dateWindowStart(input.endDate, input.days)}
            ORDER BY m.date ASC`,
      );

      // Load personalized stress thresholds
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);

      const daily: DailyStressRow[] = rows.map((row) => {
        // Compute z-score deviations from baselines
        let hrvDeviation: number | null = null;
        if (
          row.hrv != null &&
          row.hrv_mean_60d != null &&
          row.hrv_sd_60d != null &&
          Number(row.hrv_sd_60d) > 0
        ) {
          hrvDeviation =
            Math.round(
              ((Number(row.hrv) - Number(row.hrv_mean_60d)) / Number(row.hrv_sd_60d)) * 100,
            ) / 100;
        }

        let restingHrDeviation: number | null = null;
        if (
          row.resting_hr != null &&
          row.rhr_mean_60d != null &&
          row.rhr_sd_60d != null &&
          Number(row.rhr_sd_60d) > 0
        ) {
          restingHrDeviation =
            Math.round(
              ((Number(row.resting_hr) - Number(row.rhr_mean_60d)) / Number(row.rhr_sd_60d)) * 100,
            ) / 100;
        }

        const sleepEff = row.efficiency_pct != null ? Number(row.efficiency_pct) : null;

        // Delegate to shared stress scoring algorithm
        const { stressScore } = computeDailyStress(
          { hrvDeviation, restingHrDeviation, sleepEfficiency: sleepEff },
          effective.stressThresholds,
        );

        return {
          date: row.date,
          stressScore,
          hrvDeviation,
          restingHrDeviation,
          sleepEfficiency: sleepEff != null ? Math.round(sleepEff * 10) / 10 : null,
        };
      });

      const weekly = aggregateWeeklyStress(daily);
      const latestScore = daily.length > 0 ? (daily[daily.length - 1]?.stressScore ?? null) : null;
      const trend = computeStressTrend(daily);

      return { daily, weekly, latestScore, trend };
    }),
});
