import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { CalendarDayActivities } from "../repositories/activities-calendar-repository.ts";
import { ActivitiesCalendarRepository } from "../repositories/activities-calendar-repository.ts";
import { CalendarRepository } from "../repositories/calendar-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

const activityLocationSchema = z.object({
  centroidLat: z.number(),
  centroidLng: z.number(),
  tileUrl: z.string(),
  distanceMeters: z.number().nullable(),
  elevationGainM: z.number().nullable(),
});

const activityStatSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const calendarActivityEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  activityType: z.string(),
  startedAt: timestampStringSchema,
  endedAt: timestampStringSchema.nullable(),
  durationMin: z.number(),
  location: activityLocationSchema.nullable(),
  calories: z.number().nullable(),
  tss: z.number().nullable(),
  stats: z.array(activityStatSchema),
});

const calendarDayActivitiesSchema = z.object({
  date: dateStringSchema,
  activities: z.array(calendarActivityEntrySchema),
});

const activityListInputSchema = z.object({
  weeks: z.number().int().min(1).max(52).default(4),
  endDate: endDateSchema,
  activityType: z.string().min(1).optional(),
});

const activityOverviewSchema = z.object({
  activityCount: z.number().int().nonnegative(),
  totalMinutes: z.number().nonnegative(),
  totalDistanceMeters: z.number().nonnegative(),
  totalElevationGainM: z.number().nonnegative(),
  activityTypes: z.array(z.string()),
});

export const calendarRouter = router({
  calendarData: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }): Promise<CalendarDay[]> => {
      const repo = new CalendarRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getCalendarData(input.days);
      return days.map((day) => day.toDetail());
    }),

  weekList: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(activityListInputSchema)
    .output(z.array(calendarDayActivitiesSchema))
    .query(async ({ ctx, input }) => {
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

  activityOverview: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(activityListInputSchema)
    .output(activityOverviewSchema)
    .query(async ({ ctx, input }) => {
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
      const dayGroups = await repo.getWeekList({ weeks: input.weeks, endDate: input.endDate });
      return buildActivityOverview(dayGroups, input.activityType);
    }),
});

function buildActivityOverview(dayGroups: CalendarDayActivities[], activityType?: string) {
  const activityTypes = new Set<string>();
  let activityCount = 0;
  let totalMinutes = 0;
  let totalDistanceMeters = 0;
  let totalElevationGainM = 0;

  for (const dayGroup of dayGroups) {
    for (const activity of dayGroup.activities) {
      activityTypes.add(activity.activityType);
      if (activityType && activity.activityType !== activityType) {
        continue;
      }
      activityCount += 1;
      totalMinutes += activity.durationMin;
      totalDistanceMeters += activity.location?.distanceMeters ?? 0;
      totalElevationGainM += activity.location?.elevationGainM ?? 0;
    }
  }

  return {
    activityCount,
    totalMinutes: Math.round(totalMinutes * 10) / 10,
    totalDistanceMeters: Math.round(totalDistanceMeters * 10) / 10,
    totalElevationGainM: Math.round(totalElevationGainM * 10) / 10,
    activityTypes: Array.from(activityTypes).sort(),
  };
}
