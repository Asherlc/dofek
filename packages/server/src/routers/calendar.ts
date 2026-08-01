import {
  activityDataStateSchema,
  activityDataStateUnavailableStatusSchema,
} from "@dofek/format/activity-data-state";
import { recordLocalTimeContextSchema } from "@dofek/format/record-local-time";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { ActivitiesCalendarRepository } from "../repositories/activities-calendar-repository.ts";
import { CalendarRepository } from "../repositories/calendar-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

export interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

const routePathPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const mapPreviewTileSchema = z.object({
  url: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const mapPreviewSchema = z.object({
  width: z.number(),
  height: z.number(),
  tiles: z.array(mapPreviewTileSchema),
  routePath: z.array(routePathPointSchema).nullable(),
});

const activityLocationSchema = z.object({
  centroidLat: z.number(),
  centroidLng: z.number(),
  mapPreview: mapPreviewSchema,
});

const activityStatSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    label: z.string(),
    value: z.string(),
  }),
  z.object({
    status: activityDataStateUnavailableStatusSchema,
    label: z.string(),
    reason: z.string().trim().min(1),
  }),
]);

const activityListSourceSchema = z.object({
  primarySourceLabel: z.string(),
  sourceCount: z.number().int().positive(),
  overlapSummary: z.string().nullable(),
});

const calendarActivityEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  activityType: z.string(),
  startedAt: timestampStringSchema,
  endedAt: timestampStringSchema.nullable(),
  localTimeContext: recordLocalTimeContextSchema,
  durationMin: z.number(),
  source: activityListSourceSchema,
  lastProcessedAt: timestampStringSchema.nullable(),
  distanceMeters: z.number().nullable(),
  distanceState: activityDataStateSchema,
  elevationGainM: z.number().nullable(),
  elevationState: activityDataStateSchema,
  location: activityLocationSchema.nullable(),
  tss: z.number().nullable(),
  stats: z.array(activityStatSchema),
  isProviderAbsent: z.boolean().optional(),
  providerId: z.string().optional(),
  providerAbsentAt: timestampStringSchema.nullable().optional(),
  partialAbsentSources: z
    .array(
      z.object({
        providerId: z.string(),
        providerAbsentAt: timestampStringSchema.nullable(),
        subsource: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const calendarDayActivitiesSchema = z.object({
  date: dateStringSchema,
  activities: z.array(calendarActivityEntrySchema),
});

const activityListInputSchema = z.object({
  weeks: z.number().int().min(1).max(52).default(4),
  endDate: endDateSchema,
  activityType: z.string().min(1).optional(),
  includeProviderAbsent: z.boolean().default(false).optional(),
});

const activityOverviewSchema = z.object({
  activityCount: z.number().int().nonnegative(),
  totalMinutes: z.number().nonnegative(),
  totalDistanceMeters: z.number().nonnegative().nullable(),
  totalDistanceState: activityDataStateSchema,
  totalElevationGainM: z.number().nonnegative().nullable(),
  totalElevationState: activityDataStateSchema,
  activityTypes: z.array(z.string()),
});

export const calendarRouter = router({
  calendarData: selectedChartRangeQuery(
    "calendar.calendarData",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<CalendarDay[]> => {
      const repo = new CalendarRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getCalendarData(range.days);
      return days.map((day) => day.toDetail());
    },
  ),

  weekList: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "activity-calendar-states-v1",
  })
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
      await ensureProvidersRegistered();
      const repo = new ActivitiesCalendarRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      return repo.getWeekList(input);
    }),

  activityOverview: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "activity-calendar-states-v1",
  })
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
      return repo.getActivityOverview(input);
    }),
});
