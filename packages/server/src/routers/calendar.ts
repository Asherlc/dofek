import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const calendarRowSchema = z.object({
  date: dateStringSchema,
  activity_count: z.coerce.number(),
  total_minutes: z.coerce.number(),
  activity_types: z.array(z.string()),
});

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
      const rows = await executeWithSchema(
        ctx.db,
        calendarRowSchema,
        sql`SELECT
          a.started_at::date as date,
          COUNT(*)::int as activity_count,
          ROUND(SUM(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60)::numeric) as total_minutes,
          array_agg(DISTINCT a.activity_type) as activity_types
        FROM fitness.v_activity a
        WHERE a.user_id = ${ctx.userId}
          AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
          AND a.ended_at IS NOT NULL
        GROUP BY a.started_at::date
        ORDER BY date`,
      );

      return rows.map((r) => ({
        date: r.date,
        activityCount: r.activity_count,
        totalMinutes: r.total_minutes,
        activityTypes: r.activity_types,
      }));
    }),
});
