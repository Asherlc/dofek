import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const efficiencyRouter = router({
  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% of max HR.
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   *
   * NOTE: This still hits raw metric_stream because we need per-sample Z2 filtering
   * that isn't captured in activity_summary. However, the query is scoped by
   * activity_id from activity_summary, limiting the scan.
   */
  aerobicEfficiency: cachedProtectedQuery(CacheTTL.LONG)
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
        sql`WITH user_hr AS (
              SELECT id, max_hr FROM fitness.user_profile WHERE id = ${ctx.userId} AND max_hr IS NOT NULL LIMIT 1
            )
            SELECT
              uh.max_hr,
              a.started_at::date AS date,
              a.activity_type,
              a.name,
              ROUND(AVG(ms.power)::numeric, 1) AS avg_power_z2,
              ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr_z2,
              ROUND((AVG(ms.power)::numeric / NULLIF(AVG(ms.heart_rate), 0))::numeric, 3) AS efficiency_factor,
              COUNT(*)::int AS z2_samples
            FROM user_hr uh
            JOIN fitness.v_activity a ON a.user_id = uh.id
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.heart_rate >= uh.max_hr * 0.6
              AND ms.heart_rate < uh.max_hr * 0.7
              AND ms.power > 0
            GROUP BY a.id, a.started_at, a.activity_type, a.name, uh.max_hr
            HAVING COUNT(*) >= 300
            ORDER BY a.started_at`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0].max_hr) : null;

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
              WHERE a.user_id = ${ctx.userId}
                AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
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
   * Reads from activity_hr_zones rollup view + user_profile.max_hr.
   *
   * Uses a 3-zone re-bucketing of the 5-zone data:
   *   Z1 (easy) = zones 1-3 (< 80% max HR)
   *   Z2 (threshold) = zone 4 part (80-87.5% max HR) — approximated as zone4
   *   Z3 (high intensity) = zone 4 part + zone 5 (≥87.5% max HR) — approximated as zone5
   *
   * PI = log10((Z1_time / (Z2_time * Z3_time)) * 100)
   * PI > 2.0 indicates a well-polarized training distribution.
   */
  polarizationTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        max_hr: number;
        week: string;
        z1_seconds: number;
        z2_seconds: number;
        z3_seconds: number;
      }>(
        sql`SELECT
              up.max_hr,
              date_trunc('week', asum.started_at)::date AS week,
              -- Z1 (easy): < 80% max HR = zone1 + zone2 + zone3
              SUM(hz.zone1_count + hz.zone2_count + hz.zone3_count)::int AS z1_seconds,
              -- Z2 (threshold): 80-90% max HR = zone4
              SUM(hz.zone4_count)::int AS z2_seconds,
              -- Z3 (high intensity): >= 90% max HR = zone5
              SUM(hz.zone5_count)::int AS z3_seconds
            FROM fitness.activity_hr_zones hz
            JOIN fitness.activity_summary asum ON asum.activity_id = hz.activity_id
            JOIN fitness.user_profile up ON up.id = hz.user_id
            WHERE up.id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND up.max_hr IS NOT NULL
            GROUP BY up.max_hr, date_trunc('week', asum.started_at)
            ORDER BY week`,
      );

      const maxHr = rows.length > 0 ? Number(rows[0].max_hr) : null;

      const weeks = rows.map((row) => {
        const z1 = Number(row.z1_seconds);
        const z2 = Number(row.z2_seconds);
        const z3 = Number(row.z3_seconds);

        // Compute Polarization Index: log10((z1 / (z2 * z3)) * 100)
        // Handle division by zero: if z2 or z3 is 0, PI is undefined
        let polarizationIndex: number | null = null;
        if (z2 > 0 && z3 > 0 && z1 > 0) {
          const ratio = (z1 / (z2 * z3)) * 100;
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
