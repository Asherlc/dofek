import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const trainingRouter = router({
  /**
   * Weekly training volume grouped by activity type.
   * Returns hours and count per activity type per ISO week.
   */
  weeklyVolume: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT
              date_trunc('week', started_at)::date AS week,
              activity_type,
              COUNT(*)::int AS count,
              ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600)::numeric, 2) AS hours
            FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ended_at IS NOT NULL
            GROUP BY date_trunc('week', started_at), activity_type
            ORDER BY week`,
      );
      return rows;
    }),

  /**
   * HR zone distribution per week.
   * Computes 5-zone Karvonen model at query time from metric_stream.
   * Zones use % of Heart Rate Reserve: Z1 <60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 >=90%.
   */
  hrZones: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{
        max_hr: number | null;
        week: string;
        zone1: number;
        zone2: number;
        zone3: number;
        zone4: number;
        zone5: number;
      }>(
        sql`SELECT
              up.max_hr,
              date_trunc('week', a.started_at)::date AS week,
              COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6)::int AS zone1,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7)::int AS zone2,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8)::int AS zone3,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone4,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone5
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
      const rawMaxHr = rows[0]?.max_hr;
      const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
      if (!maxHr) return { maxHr: null, weeks: [] };
      return { maxHr, weeks: rows };
    }),

  /**
   * Per-activity summary with HR and power stats.
   * Reads from pre-computed activity_summary rollup view.
   */
  activityStats: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT
              asum.activity_id AS id,
              asum.activity_type,
              asum.name,
              asum.started_at,
              asum.ended_at,
              ROUND(asum.avg_hr::numeric, 1) AS avg_hr,
              asum.max_hr,
              ROUND(asum.avg_power::numeric, 1) AS avg_power,
              asum.max_power,
              ROUND(asum.avg_cadence::numeric, 1) AS avg_cadence,
              asum.hr_sample_count AS hr_samples,
              asum.power_sample_count AS power_samples
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY asum.started_at DESC`,
      );
      return rows;
    }),
});
