import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

export const calendarRouter = router({
  calendarData: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        days: z.number().default(365),
      }),
    )
    .query(async ({ ctx, input }): Promise<CalendarDay[]> => {
      const rows = await ctx.db.execute<{
        date: string;
        activity_count: number;
        total_minutes: string;
        activity_types: string[];
      }>(sql`
        SELECT
          a.started_at::date as date,
          COUNT(*)::int as activity_count,
          ROUND(SUM(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60)::numeric) as total_minutes,
          array_agg(DISTINCT a.activity_type) as activity_types
        FROM fitness.v_activity a
        WHERE a.user_id = ${ctx.userId}
          AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
          AND a.ended_at IS NOT NULL
        GROUP BY a.started_at::date
        ORDER BY date
      `);

      return rows.map((r) => ({
        date: String(r.date),
        activityCount: Number(r.activity_count),
        totalMinutes: Number(r.total_minutes),
        activityTypes: r.activity_types,
      }));
    }),
});
