import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

export const trainingRouter = router({
  /**
   * Weekly training volume grouped by activity type.
   * Returns hours and count per activity type per ISO week.
   */
  weeklyVolume: publicProcedure
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT
              date_trunc('week', started_at)::date AS week,
              activity_type,
              COUNT(*)::int AS count,
              ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600)::numeric, 2) AS hours
            FROM fitness.v_activity
            WHERE started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ended_at IS NOT NULL
            GROUP BY date_trunc('week', started_at), activity_type
            ORDER BY week`,
      );
      return rows;
    }),

  /**
   * HR zone distribution per week.
   * Uses max observed HR to define 5 zones (60/70/80/90% thresholds).
   * Each record in metric_stream ≈ 1 second of recording time.
   */
  hrZones: publicProcedure
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      // First get max observed HR (used as proxy for max HR)
      const maxHrResult = await ctx.db.execute(
        sql`SELECT MAX(heart_rate) AS max_hr
            FROM fitness.metric_stream
            WHERE heart_rate IS NOT NULL
              AND activity_id IS NOT NULL`,
      );
      const maxHr = (maxHrResult as Record<string, unknown>[])[0]?.max_hr as number | null;
      if (!maxHr) return { maxHr: null, weeks: [] };

      const rows = await ctx.db.execute(
        sql`SELECT
              date_trunc('week', ms.recorded_at)::date AS week,
              COUNT(*) FILTER (WHERE ms.heart_rate < ${maxHr} * 0.6)::int AS zone1,
              COUNT(*) FILTER (WHERE ms.heart_rate >= ${maxHr} * 0.6 AND ms.heart_rate < ${maxHr} * 0.7)::int AS zone2,
              COUNT(*) FILTER (WHERE ms.heart_rate >= ${maxHr} * 0.7 AND ms.heart_rate < ${maxHr} * 0.8)::int AS zone3,
              COUNT(*) FILTER (WHERE ms.heart_rate >= ${maxHr} * 0.8 AND ms.heart_rate < ${maxHr} * 0.9)::int AS zone4,
              COUNT(*) FILTER (WHERE ms.heart_rate >= ${maxHr} * 0.9)::int AS zone5
            FROM fitness.metric_stream ms
            WHERE ms.heart_rate IS NOT NULL
              AND ms.activity_id IS NOT NULL
              AND ms.recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            GROUP BY date_trunc('week', ms.recorded_at)
            ORDER BY week`,
      );
      return { maxHr, weeks: rows };
    }),

  /**
   * Per-activity summary with HR and power stats.
   * Useful for activity-level analysis and eFTP estimation.
   */
  activityStats: publicProcedure
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(
        sql`SELECT
              a.id,
              a.activity_type,
              a.name,
              a.started_at,
              a.ended_at,
              ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr,
              MAX(ms.heart_rate) AS max_hr,
              ROUND(AVG(ms.power) FILTER (WHERE ms.power > 0)::numeric, 1) AS avg_power,
              MAX(ms.power) FILTER (WHERE ms.power > 0) AS max_power,
              ROUND(AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::numeric, 1) AS avg_cadence,
              COUNT(ms.heart_rate)::int AS hr_samples,
              COUNT(ms.power) FILTER (WHERE ms.power > 0)::int AS power_samples
            FROM fitness.v_activity a
            LEFT JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            WHERE a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            GROUP BY a.id, a.activity_type, a.name, a.started_at, a.ended_at
            ORDER BY a.started_at DESC`,
      );
      return rows;
    }),
});
