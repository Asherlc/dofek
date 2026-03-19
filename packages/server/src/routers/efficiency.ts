import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface AerobicEfficiencyActivity {
  date: string;
  activityType: string;
  name: string;
  avgPowerZ2: number;
  avgHrZ2: number;
  efficiencyFactor: number;
  z2Samples: number;
}

export interface AerobicEfficiencyResult {
  maxHr: number | null;
  activities: AerobicEfficiencyActivity[];
}

export interface AerobicDecouplingActivity {
  date: string;
  activityType: string;
  name: string;
  firstHalfRatio: number;
  secondHalfRatio: number;
  decouplingPct: number;
  totalSamples: number;
}

export interface PolarizationWeek {
  week: string;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
  polarizationIndex: number | null;
}

export interface PolarizationTrendResult {
  maxHr: number | null;
  weeks: PolarizationWeek[];
}

export const efficiencyRouter = router({
  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% HRR (Karvonen).
   * Uses nearest resting HR from daily metrics for each activity's date.
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   */
  aerobicEfficiency: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicEfficiencyResult> => {
      const efficiencyRowSchema = z.object({
        max_hr: z.coerce.number(),
        date: z.string(),
        activity_type: z.string(),
        name: z.string(),
        avg_power_z2: z.coerce.number(),
        avg_hr_z2: z.coerce.number(),
        efficiency_factor: z.coerce.number(),
        z2_samples: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        efficiencyRowSchema,
        sql`SELECT
              up.max_hr,
              a.started_at::date AS date,
              a.activity_type,
              a.name,
              ROUND(AVG(ms.power)::numeric, 1) AS avg_power_z2,
              ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr_z2,
              ROUND((AVG(ms.power)::numeric / NULLIF(AVG(ms.heart_rate), 0))::numeric, 3) AS efficiency_factor,
              COUNT(*)::int AS z2_samples
            FROM fitness.user_profile up
            JOIN fitness.v_activity a ON a.user_id = up.id
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            JOIN LATERAL (
              SELECT dm.resting_hr
              FROM fitness.v_daily_metrics dm
              WHERE dm.user_id = up.id
                AND dm.date <= a.started_at::date
                AND dm.resting_hr IS NOT NULL
              ORDER BY dm.date DESC
              LIMIT 1
            ) rhr ON true
            WHERE up.id = ${ctx.userId}
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("a")}
              AND up.max_hr IS NOT NULL
              AND ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
              AND ms.power > 0
            GROUP BY a.id, a.started_at, a.activity_type, a.name, up.max_hr
            HAVING COUNT(*) >= 300
            ORDER BY a.started_at`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0]?.max_hr) : null;

      return {
        maxHr,
        activities: rows.map((row) => ({
          date: String(row.date),
          activityType: String(row.activity_type),
          name: String(row.name),
          avgPowerZ2: Number(row.avg_power_z2),
          avgHrZ2: Number(row.avg_hr_z2),
          efficiencyFactor: Number(row.efficiency_factor),
          z2Samples: Number(row.z2_samples),
        })),
      };
    }),

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  aerobicDecoupling: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicDecouplingActivity[]> => {
      const decouplingRowSchema = z.object({
        date: z.string(),
        activity_type: z.string(),
        name: z.string(),
        first_half_ratio: z.coerce.number(),
        second_half_ratio: z.coerce.number(),
        decoupling_pct: z.coerce.number(),
        total_samples: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        decouplingRowSchema,
        sql`WITH activity_halves AS (
              SELECT
                ms.activity_id,
                ms.power,
                ms.heart_rate,
                NTILE(2) OVER (PARTITION BY ms.activity_id ORDER BY ms.recorded_at) AS half
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
                AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
                AND ${enduranceTypeFilter("a")}
                AND ms.power > 0
                AND ms.heart_rate > 0
            ),
            half_ratios AS (
              SELECT
                activity_id,
                ROUND(
                  (AVG(power) FILTER (WHERE half = 1))::numeric /
                  NULLIF(AVG(heart_rate) FILTER (WHERE half = 1), 0)::numeric, 3
                ) AS first_half_ratio,
                ROUND(
                  (AVG(power) FILTER (WHERE half = 2))::numeric /
                  NULLIF(AVG(heart_rate) FILTER (WHERE half = 2), 0)::numeric, 3
                ) AS second_half_ratio,
                COUNT(*)::int AS total_samples
              FROM activity_halves
              GROUP BY activity_id
              HAVING COUNT(*) >= 600
            )
            SELECT
              a.started_at::date AS date,
              a.activity_type,
              a.name,
              hr.first_half_ratio,
              hr.second_half_ratio,
              ROUND(
                ((hr.first_half_ratio - hr.second_half_ratio) / NULLIF(hr.first_half_ratio, 0) * 100)::numeric, 2
              ) AS decoupling_pct,
              hr.total_samples
            FROM half_ratios hr
            JOIN fitness.v_activity a ON a.id = hr.activity_id
            WHERE hr.first_half_ratio > 0 AND hr.second_half_ratio > 0
            ORDER BY a.started_at`,
      );

      return rows.map((row) => ({
        date: String(row.date),
        activityType: String(row.activity_type),
        name: String(row.name),
        firstHalfRatio: Number(row.first_half_ratio),
        secondHalfRatio: Number(row.second_half_ratio),
        decouplingPct: Number(row.decoupling_pct),
        totalSamples: Number(row.total_samples),
      }));
    }),

  /**
   * Polarization Index trend per week using Treff 3-zone model.
   * Computes Karvonen zones at query time from metric_stream + v_daily_metrics.
   *
   * Uses a 3-zone re-bucketing:
   *   Z1 (easy) = < 80% HRR (Karvonen zones 1-3)
   *   Z2 (threshold) = 80-90% HRR (Karvonen zone 4)
   *   Z3 (high intensity) = ≥ 90% HRR (Karvonen zone 5)
   *
   * PI = log10((f1 / (f2 * f3)) * 100) where f = fraction of total training time
   * PI > 2.0 indicates a well-polarized training distribution.
   */
  polarizationTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PolarizationTrendResult> => {
      const polarizationRowSchema = z.object({
        max_hr: z.coerce.number(),
        week: z.string(),
        z1_seconds: z.coerce.number(),
        z2_seconds: z.coerce.number(),
        z3_seconds: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        polarizationRowSchema,
        sql`SELECT
              up.max_hr,
              date_trunc('week', a.started_at)::date AS week,
              -- Z1 (easy): < 80% HRR
              COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8)::int AS z1_seconds,
              -- Z2 (threshold): 80-90% HRR
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS z2_seconds,
              -- Z3 (high intensity): >= 90% HRR
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS z3_seconds
            FROM fitness.user_profile up
            JOIN fitness.v_activity a ON a.user_id = up.id
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            JOIN LATERAL (
              SELECT dm.resting_hr
              FROM fitness.v_daily_metrics dm
              WHERE dm.user_id = up.id
                AND dm.date <= a.started_at::date
                AND dm.resting_hr IS NOT NULL
              ORDER BY dm.date DESC
              LIMIT 1
            ) rhr ON true
            WHERE up.id = ${ctx.userId}
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("a")}
              AND up.max_hr IS NOT NULL
              AND ms.heart_rate IS NOT NULL
            GROUP BY up.max_hr, date_trunc('week', a.started_at)
            ORDER BY week`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0]?.max_hr) : null;

      const weeks = rows.map((row) => {
        const z1 = Number(row.z1_seconds);
        const z2 = Number(row.z2_seconds);
        const z3 = Number(row.z3_seconds);

        // Treff Polarization Index: log10((f1 / (f2 * f3)) * 100)
        // where f = fraction of total training time (not raw seconds)
        let polarizationIndex: number | null = null;
        const total = z1 + z2 + z3;
        if (z2 > 0 && z3 > 0 && z1 > 0 && total > 0) {
          const f1 = z1 / total;
          const f2 = z2 / total;
          const f3 = z3 / total;
          const ratio = (f1 / (f2 * f3)) * 100;
          polarizationIndex = Math.round(Math.log10(ratio) * 1000) / 1000;
        }

        return {
          week: String(row.week),
          z1Seconds: z1,
          z2Seconds: z2,
          z3Seconds: z3,
          polarizationIndex,
        };
      });

      return { maxHr, weeks };
    }),
});
