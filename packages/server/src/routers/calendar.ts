import { z } from "zod";
import { CalendarRepository } from "../repositories/calendar-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

export const calendarRouter = router({
  calendarData: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }): Promise<CalendarDay[]> => {
      const repo = new CalendarRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getCalendarData(input.days);
      return days.map((day) => day.toDetail());
    }),
});
