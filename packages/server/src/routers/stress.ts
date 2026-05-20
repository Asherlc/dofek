import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
  type WeeklyStressRow,
} from "@dofek/recovery/stress";
import { TRPCError } from "@trpc/server";

export type { WeeklyStressRow };

import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateAccessPredicate } from "../billing/entitlement.ts";
import { dateWindowStart, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { fetchSleepNights } from "../repositories/clickhouse-sleep-repository.ts";
import {
  fetchRestingHeartRateRows,
  restingHeartRateValuesCte,
} from "../repositories/resting-heart-rate-query.ts";
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
    .input(z.object({ days: z.number().min(1).max(365).default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StressResult> => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "stress.scores requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
        });
      }

      const queryDays = input.days + 60; // extra for baseline windows
      const restingHeartRateRows = await fetchRestingHeartRateRows({
        sensorStore: ctx.sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate: input.endDate,
        days: queryDays,
      });
      const restingHeartRateCte = restingHeartRateValuesCte(restingHeartRateRows);

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
      const [metricRows, sleepRows] = await Promise.all([
        executeWithSchema(
          ctx.db,
          rawRowSchema,
          sql`WITH ${restingHeartRateCte},
            metrics AS (
              SELECT
                dm.date,
                dm.hrv,
                drhr.resting_hr,
                AVG(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_mean_60d,
                STDDEV_POP(dm.hrv) OVER (ORDER BY dm.date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS hrv_sd_60d,
                AVG(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_mean_60d,
                STDDEV_POP(drhr.resting_hr) OVER (ORDER BY dm.date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS rhr_sd_60d
              FROM fitness.v_daily_metrics dm
              LEFT JOIN resting_heart_rate drhr
                ON drhr.date = dm.date
              WHERE dm.user_id = ${ctx.userId}
                AND dm.date > ${dateWindowStart(input.endDate, queryDays)}
                ${dateAccessPredicate(ctx.accessWindow, sql`dm.date`)}
              ORDER BY dm.date ASC
            )
            SELECT
              m.date::text,
              m.hrv,
              m.resting_hr,
              m.hrv_mean_60d,
              m.hrv_sd_60d,
              m.rhr_mean_60d,
              m.rhr_sd_60d,
              NULL::real AS efficiency_pct
            FROM metrics m
            WHERE m.date > ${dateWindowStart(input.endDate, input.days)}
            ORDER BY m.date ASC`,
        ),
        fetchSleepNights({
          sensorStore: ctx.sensorStore,
          userId: ctx.userId,
          timezone: ctx.timezone,
          endDate: input.endDate,
          days: queryDays,
          accessWindow: ctx.accessWindow,
          order: "asc",
        }),
      ]);
      const sleepEfficiencyByDate = new Map(sleepRows.map((row) => [row.date, row.efficiency_pct]));
      const rows = metricRows.map((row) => ({
        ...row,
        efficiency_pct: sleepEfficiencyByDate.get(row.date) ?? null,
      }));

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
