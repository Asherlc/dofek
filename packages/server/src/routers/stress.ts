import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

/**
 * Whoop's Stress Monitor scores stress 0-3 by comparing current HR/HRV to personal baseline.
 * We replicate this as a daily metric since we don't have real-time continuous HR during the day.
 *
 * Daily stress = composite of:
 * - HRV deviation below personal baseline (lower HRV = more stress)
 * - Resting HR elevation above baseline (higher RHR = more stress)
 * - Sleep quality deficit (poor sleep = residual stress)
 *
 * Score: 0 (no stress) to 3 (high stress), matching Whoop's scale.
 * Cumulative weekly stress = sum of daily scores.
 */

export interface DailyStressRow {
  date: string;
  /** Stress score 0-3 (Whoop scale) */
  stressScore: number;
  /** HRV z-score vs 60-day baseline (negative = below baseline = stressed) */
  hrvDeviation: number | null;
  /** Resting HR z-score vs 60-day baseline (positive = above baseline = stressed) */
  restingHrDeviation: number | null;
  /** Sleep efficiency from previous night */
  sleepEfficiency: number | null;
}

export interface WeeklyStressRow {
  weekStart: string;
  /** Cumulative stress for the week (sum of daily 0-3 scores, max 21) */
  cumulativeStress: number;
  /** Average daily stress */
  avgDailyStress: number;
  /** Number of high-stress days (score >= 2) */
  highStressDays: number;
}

export interface StressResult {
  /** Daily stress scores */
  daily: DailyStressRow[];
  /** Weekly cumulative stress */
  weekly: WeeklyStressRow[];
  /** Today's stress score (or latest available) */
  latestScore: number | null;
  /** Trend direction over last 7 days: "improving" | "worsening" | "stable" */
  trend: "improving" | "worsening" | "stable";
}

export const stressRouter = router({
  /**
   * Stress Monitor — daily stress scores from HR/HRV deviation against personal baselines.
   * Mirrors Whoop's 0-3 stress scale with cumulative weekly tracking.
   */
  scores: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<StressResult> => {
      const queryDays = input.days + 60; // extra for baseline windows

      const rawRowSchema = z.object({
        date: z.string(),
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
                AND date > CURRENT_DATE - ${queryDays}::int
              ORDER BY date ASC
            ),
            sleep_eff AS (
              SELECT DISTINCT ON (started_at::date)
                started_at::date AS date,
                efficiency_pct
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
              ORDER BY started_at::date, started_at DESC
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
            WHERE m.date > CURRENT_DATE - ${input.days}::int
            ORDER BY m.date ASC`,
      );

      // Load personalized stress thresholds
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const effective = getEffectiveParams(storedParams);
      const [hrvHigh, hrvMed, hrvLow] = effective.stressThresholds.hrvThresholds;
      const [rhrHigh, rhrMed, rhrLow] = effective.stressThresholds.rhrThresholds;

      const daily: DailyStressRow[] = rows.map((row) => {
        // HRV deviation: negative z-score = below baseline = stressed
        let hrvDeviation: number | null = null;
        let hrvStress = 0;
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
          // More negative = more stress (personalized thresholds)
          if (hrvDeviation < hrvHigh) hrvStress = 1.5;
          else if (hrvDeviation < hrvMed) hrvStress = 1.2;
          else if (hrvDeviation < hrvLow) hrvStress = 0.8;
          else if (hrvDeviation < 0) hrvStress = 0.3;
        }

        // Resting HR deviation: positive z-score = above baseline = stressed
        let restingHrDeviation: number | null = null;
        let rhrStress = 0;
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
          if (restingHrDeviation > rhrHigh) rhrStress = 1.0;
          else if (restingHrDeviation > rhrMed) rhrStress = 0.8;
          else if (restingHrDeviation > rhrLow) rhrStress = 0.5;
          else if (restingHrDeviation > 0) rhrStress = 0.2;
        }

        // Sleep quality: poor sleep = residual stress
        const sleepEff = row.efficiency_pct != null ? Number(row.efficiency_pct) : null;
        let sleepStress = 0;
        if (sleepEff != null) {
          if (sleepEff < 70) sleepStress = 0.5;
          else if (sleepEff < 80) sleepStress = 0.3;
          else if (sleepEff < 85) sleepStress = 0.1;
        }

        // Composite: cap at 3.0
        const raw = hrvStress + rhrStress + sleepStress;
        const stressScore = Math.min(3, Math.round(raw * 10) / 10);

        return {
          date: row.date,
          stressScore,
          hrvDeviation,
          restingHrDeviation,
          sleepEfficiency: sleepEff != null ? Math.round(sleepEff * 10) / 10 : null,
        };
      });

      // Weekly aggregation
      const weekMap = new Map<string, { scores: number[]; highDays: number }>();
      for (const d of daily) {
        const date = new Date(d.date);
        // ISO week start (Monday)
        const dayOfWeek = date.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const monday = new Date(date);
        monday.setDate(date.getDate() - diff);
        const weekKey = monday.toISOString().split("T")[0] ?? "";

        const existing = weekMap.get(weekKey) ?? { scores: [], highDays: 0 };
        existing.scores.push(d.stressScore);
        if (d.stressScore >= 2) existing.highDays++;
        weekMap.set(weekKey, existing);
      }

      const weekly: WeeklyStressRow[] = Array.from(weekMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, data]) => ({
          weekStart,
          cumulativeStress: Math.round(data.scores.reduce((s, v) => s + v, 0) * 10) / 10,
          avgDailyStress:
            Math.round((data.scores.reduce((s, v) => s + v, 0) / data.scores.length) * 100) / 100,
          highStressDays: data.highDays,
        }));

      // Latest score
      const latestScore = daily.length > 0 ? (daily[daily.length - 1]?.stressScore ?? null) : null;

      // Trend: compare last 7 days avg to previous 7 days
      let trend: "improving" | "worsening" | "stable" = "stable";
      if (daily.length >= 14) {
        const last7 = daily.slice(-7);
        const prev7 = daily.slice(-14, -7);
        const avgLast = last7.reduce((s, d) => s + d.stressScore, 0) / 7;
        const avgPrev = prev7.reduce((s, d) => s + d.stressScore, 0) / 7;
        const diff = avgLast - avgPrev;
        if (diff < -0.3) trend = "improving";
        else if (diff > 0.3) trend = "worsening";
      }

      return { daily, weekly, latestScore, trend };
    }),
});
