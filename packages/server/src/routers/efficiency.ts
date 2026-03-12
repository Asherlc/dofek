import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedQuery, router } from "../trpc.ts";

export const efficiencyRouter = router({
  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% of max HR.
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   */
  aerobicEfficiency: cachedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        max_hr: number;
        date: string;
        activity_type: string;
        name: string;
        avg_power_z2: number;
        avg_hr_z2: number;
        efficiency_factor: number;
        z2_samples: number;
      }>(
        sql`WITH max_hr AS (
              SELECT MAX(heart_rate) AS val
              FROM fitness.metric_stream
              WHERE heart_rate IS NOT NULL
                AND activity_id IS NOT NULL
            )
            SELECT
              (SELECT val FROM max_hr) AS max_hr,
              a.started_at::date AS date,
              a.activity_type,
              a.name,
              ROUND(AVG(ms.power)::numeric, 1) AS avg_power_z2,
              ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr_z2,
              ROUND((AVG(ms.power)::numeric / NULLIF(AVG(ms.heart_rate), 0))::numeric, 3) AS efficiency_factor,
              COUNT(*)::int AS z2_samples
            FROM fitness.v_activity a
            CROSS JOIN max_hr
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE max_hr.val IS NOT NULL
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.heart_rate >= max_hr.val * 0.6
              AND ms.heart_rate < max_hr.val * 0.7
              AND ms.power > 0
            GROUP BY a.id, a.started_at, a.activity_type, a.name, max_hr.val
            HAVING COUNT(*) >= 300
            ORDER BY a.started_at`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0].max_hr) : null;

      return {
        maxHr,
        activities: rows.map((r) => ({
          date: String(r.date),
          activityType: String(r.activity_type),
          name: String(r.name),
          avgPowerZ2: Number(r.avg_power_z2),
          avgHrZ2: Number(r.avg_hr_z2),
          efficiencyFactor: Number(r.efficiency_factor),
          z2Samples: Number(r.z2_samples),
        })),
      };
    }),

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  aerobicDecoupling: cachedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        date: string;
        activity_type: string;
        name: string;
        first_half_ratio: number;
        second_half_ratio: number;
        decoupling_pct: number;
        total_samples: number;
      }>(
        sql`WITH activity_halves AS (
              SELECT
                ms.activity_id,
                ms.power,
                ms.heart_rate,
                NTILE(2) OVER (PARTITION BY ms.activity_id ORDER BY ms.recorded_at) AS half
              FROM fitness.metric_stream ms
              JOIN fitness.v_activity a ON a.id = ms.activity_id
              WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
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

      return rows.map((r) => ({
        date: String(r.date),
        activityType: String(r.activity_type),
        name: String(r.name),
        firstHalfRatio: Number(r.first_half_ratio),
        secondHalfRatio: Number(r.second_half_ratio),
        decouplingPct: Number(r.decoupling_pct),
        totalSamples: Number(r.total_samples),
      }));
    }),

  /**
   * Polarization Index trend per week using Treff 3-zone model.
   * Z1 = below 80% max HR (easy), Z2 = 80-87.5% (threshold), Z3 = above 87.5% (high intensity).
   * PI = log10((Z1_time / (Z2_time * Z3_time)) * 100)
   * PI > 2.0 indicates a well-polarized training distribution.
   */
  polarizationTrend: cachedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        max_hr: number;
        week: string;
        z1_seconds: number;
        z2_seconds: number;
        z3_seconds: number;
      }>(
        sql`WITH max_hr AS (
              SELECT MAX(heart_rate) AS val
              FROM fitness.metric_stream
              WHERE heart_rate IS NOT NULL
                AND activity_id IS NOT NULL
            )
            SELECT
              (SELECT val FROM max_hr) AS max_hr,
              date_trunc('week', ms.recorded_at)::date AS week,
              COUNT(*) FILTER (WHERE ms.heart_rate < max_hr.val * 0.80)::int AS z1_seconds,
              COUNT(*) FILTER (WHERE ms.heart_rate >= max_hr.val * 0.80 AND ms.heart_rate < max_hr.val * 0.875)::int AS z2_seconds,
              COUNT(*) FILTER (WHERE ms.heart_rate >= max_hr.val * 0.875)::int AS z3_seconds
            FROM fitness.metric_stream ms
            CROSS JOIN max_hr
            WHERE ms.heart_rate IS NOT NULL
              AND ms.activity_id IS NOT NULL
              AND ms.recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND max_hr.val IS NOT NULL
            GROUP BY date_trunc('week', ms.recorded_at), max_hr.val
            ORDER BY week`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0].max_hr) : null;

      const weeks = rows.map((r) => {
        const z1 = Number(r.z1_seconds);
        const z2 = Number(r.z2_seconds);
        const z3 = Number(r.z3_seconds);

        // Compute Polarization Index: log10((z1 / (z2 * z3)) * 100)
        // Handle division by zero: if z2 or z3 is 0, PI is undefined
        let polarizationIndex: number | null = null;
        if (z2 > 0 && z3 > 0 && z1 > 0) {
          const ratio = (z1 / (z2 * z3)) * 100;
          polarizationIndex = Math.round(Math.log10(ratio) * 1000) / 1000;
        }

        return {
          week: String(r.week),
          z1Seconds: z1,
          z2Seconds: z2,
          z3Seconds: z3,
          polarizationIndex,
        };
      });

      return { maxHr, weeks };
    }),
});
