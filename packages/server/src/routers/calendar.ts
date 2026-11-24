import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import { activityOverviewComparisonSchema } from "@dofek/format/activity-overview";
import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  ACTIVITY_HEATMAP_BAND_IDS,
  type ActivityHeatmapBandId,
  ActivityHeatmapDataError,
} from "@dofek/training/activity-heatmap";
import { TRPCError } from "@trpc/server";
import { createActivitySearchIndexFromEnv } from "dofek/activity-search/config";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import {
  calendarActivityEntrySchema,
  datedCalendarActivityEntrySchema,
} from "../contracts/calendar-activity-entry.ts";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { ActivitiesCalendarRepository } from "../repositories/activities-calendar-repository.ts";
import { ActivityOverviewRepository } from "../repositories/activity-overview-repository.ts";
import { activitySearchCursorSchema } from "../repositories/activity-search-pagination.ts";
import { searchActivityTitles } from "../repositories/activity-title-search.ts";
import { CalendarRepository } from "../repositories/calendar-repository.ts";
import {
  PlannedWorkoutRepository,
  plannedWorkoutDaySchema,
} from "../repositories/planned-workout-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

const MAX_PLANNED_RANGE_INCLUSIVE_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/** Shared inverted/too-long check for explicit agenda and planned date ranges. */
function inclusiveExplicitRangeError(startDate: string, endDate: string): string | null {
  if (startDate > endDate) {
    return "startDate must be on or before endDate.";
  }
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "startDate and endDate must be valid calendar dates.";
  }
  const inclusiveDays = Math.round((endMs - startMs) / MS_PER_DAY) + 1;
  if (inclusiveDays > MAX_PLANNED_RANGE_INCLUSIVE_DAYS) {
    return `Date range may span at most ${MAX_PLANNED_RANGE_INCLUSIVE_DAYS} inclusive calendar days.`;
  }
  return null;
}

function assertInclusivePlannedDateRange(dateRange: { startDate: string; endDate: string }) {
  const message = inclusiveExplicitRangeError(dateRange.startDate, dateRange.endDate);
  if (message) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
}

export interface CalendarDay {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
  trainingTimeBand: ActivityHeatmapBandId;
  trainingTimeMeaning: string;
}

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
  comparison: activityOverviewComparisonSchema,
});

const calendarDaySchema = z.object({
  date: dateStringSchema,
  activityCount: z.number().int().nonnegative(),
  totalMinutes: z.number().nonnegative(),
  activityTypes: z.array(z.string()),
  trainingTimeBand: z.enum(ACTIVITY_HEATMAP_BAND_IDS),
  trainingTimeMeaning: z.string().trim().min(1),
});

export const calendarRouter = router({
  calendarData: selectedChartRangeQuery(
    "calendar.calendarData",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<CalendarDay[]> => {
      const repo = new CalendarRepository(ctx.db, ctx.userId, ctx.timezone);
      try {
        const days = await repo.getCalendarData(range.days);
        return days.map((day) => day.toDetail());
      } catch (error) {
        captureException(error, { tags: { trpcPath: "calendar.calendarData" } });
        if (!(error instanceof ActivityHeatmapDataError)) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Activity calendar data is invalid. Please re-sync activities and try again.",
          cause: error,
        });
      }
    },
    { keyVersion: "calendar-calendarData-v2", outputSchema: z.array(calendarDaySchema) },
  ),

  weekList: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "activity-calendar-power-stress-v13",
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
      return new ActivitiesCalendarRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      ).getWeekList(input);
    }),

  weekListV2: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "activity-calendar-page-power-stress-v5",
    scopeByAccessWindow: true,
  })
    .input(
      activityListInputSchema
        .extend({
          startDate: z.iso.date().optional(),
          dateOrder: z.enum(["oldest", "newest"]).optional(),
          page: z.number().int().nonnegative().default(0),
          pageSize: z.number().int().min(1).max(100).default(20),
        })
        .superRefine((value, context) => {
          if (!value.startDate) return;
          const message = inclusiveExplicitRangeError(value.startDate, value.endDate);
          if (!message) return;
          context.addIssue({
            code: "custom",
            message,
            path: message.includes("on or before") ? ["startDate"] : ["endDate"],
          });
        }),
    )
    .output(
      z.object({
        days: z.array(calendarDayActivitiesSchema),
        totalCount: z.number().int().nonnegative(),
        page: z.number().int().nonnegative(),
        pageSize: z.number().int().positive(),
        plannedWindow: z
          .object({ startDate: dateStringSchema, endDate: dateStringSchema })
          .nullable()
          .optional(),
      }),
    )
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
      return repo.getPage(input);
    }),

  upcomingWorkouts: protectedProcedure
    .input(
      z
        .object({
          providerId: z.string().min(1).optional(),
          dateRange: z
            .object({
              startDate: z.iso.date(),
              endDate: z.iso.date(),
            })
            .optional(),
          activityType: z.string().min(1).optional(),
        })
        .optional(),
    )
    .output(z.array(plannedWorkoutDaySchema))
    .query(({ ctx, input }) => {
      if (input?.dateRange) {
        assertInclusivePlannedDateRange(input.dateRange);
      }
      const today = formatDateYmdInTimeZone(new Date(), ctx.timezone);
      return new PlannedWorkoutRepository(
        ctx.db,
        ctx.userId,
        today,
        input?.providerId,
        ctx.accessWindow,
      ).upcoming({
        dateRange: input?.dateRange,
        activityType: input?.activityType,
      });
    }),

  searchActivities: protectedProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        activityType: z.string().min(1).optional(),
        cursor: activitySearchCursorSchema.nullish(),
        pageSize: z.number().int().min(1).max(50).default(20),
      }),
    )
    .output(
      z.object({
        activities: z.array(datedCalendarActivityEntrySchema),
        next: activitySearchCursorSchema.nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const index = createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL");
        if (!index) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Activity search is unavailable in this environment.",
          });
        }
        const calendar = new ActivitiesCalendarRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.sensorStore,
          ctx.accessWindow,
        );
        return await searchActivityTitles(
          index,
          (ids) => calendar.findByIds(ids, input.activityType),
          {
            ...input,
            cursor: input.cursor ?? undefined,
            userId: ctx.userId,
            timezone: ctx.timezone,
            accessWindow: ctx.accessWindow,
          },
        );
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        captureException(error, { tags: { trpcPath: "calendar.searchActivities" } });
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Activity search is temporarily unavailable. Try again in a minute.",
        });
      }
    }),

  activityOverview: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "activity-calendar-primary-type-v4",
    scopeByAccessWindow: true,
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
      const repo = new ActivityOverviewRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      return repo.getActivityOverview(input);
    }),
});
