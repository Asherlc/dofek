import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import {
  ActivitiesCalendarRepository,
  type CalendarDayActivities,
} from "../repositories/activities-calendar-repository.ts";
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

  weekList: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        weeks: z.number().int().min(1).max(52).default(4),
        endDate: endDateSchema,
      }),
    )
    .query(async ({ ctx, input }): Promise<CalendarDayActivities[]> => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Activity calendar requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new ActivitiesCalendarRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      return repo.getWeekList(input);
    }),
});
