import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { CacheTTL, cachedQuery, router } from "../trpc.ts";

export const trainingRouter = router({
  /**
   * Weekly training volume grouped by activity type.
   * Returns hours and count per activity type per ISO week.
   */
  weeklyVolume: cachedQuery(CacheTTL.LONG)
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
   * Reads from pre-computed activity_hr_zones rollup view + user_profile.max_hr.
   * Each sample ≈ 1 second of recording time.
   */
  hrZones: cachedQuery(CacheTTL.LONG)
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
              date_trunc('week', asum.started_at)::date AS week,
              SUM(hz.zone1_count)::int AS zone1,
              SUM(hz.zone2_count)::int AS zone2,
              SUM(hz.zone3_count)::int AS zone3,
              SUM(hz.zone4_count)::int AS zone4,
              SUM(hz.zone5_count)::int AS zone5
            FROM fitness.activity_hr_zones hz
            JOIN fitness.activity_summary asum ON asum.activity_id = hz.activity_id
            JOIN fitness.user_profile up ON up.id = hz.user_id
            WHERE asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("asum")}
              AND up.max_hr IS NOT NULL
            GROUP BY up.max_hr, date_trunc('week', asum.started_at)
            ORDER BY week`,
      );
      const maxHr = (rows[0]?.max_hr as number | null) ?? null;
      if (!maxHr) return { maxHr: null, weeks: [] };
      return { maxHr, weeks: rows };
    }),

  /**
   * Per-activity summary with HR and power stats.
   * Reads from pre-computed activity_summary rollup view.
   */
  activityStats: cachedQuery(CacheTTL.LONG)
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
            WHERE asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY asum.started_at DESC`,
      );
      return rows;
    }),
});
