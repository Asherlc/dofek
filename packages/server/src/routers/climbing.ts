import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { climbingCatalogueContextSchema } from "@dofek/training/climbing-catalogue";
import { climbingFiltersSchema } from "@dofek/training/climbing-filters";
import { climbingLocationMapSchema } from "@dofek/training/climbing-location-map";
import { climbingResponseVersionSchema } from "@dofek/training/climbing-log-response";
import { climbingStrengthsSchema } from "@dofek/training/climbing-strengths";
import { TRPCError } from "@trpc/server";
import { createActivityImageUrl, readActivityImageObject } from "dofek/activity-images/storage";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import {
  climbingAttachmentActivitySchema,
  climbingLogEntryDetailResponseSchema,
  serializeClimbingLogEntryDetailResponse,
} from "../contracts/climbing-log-contracts.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { activityImagesOutputSchema } from "../repositories/activity-images-repository.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingCatalogueRepository } from "../repositories/climbing-catalogue-repository.ts";
import { ClimbingImagesRepository } from "../repositories/climbing-images-repository.ts";
import { ClimbingLogEntryAssociator } from "../repositories/climbing-log-entry-associator.ts";
import {
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
  climbingGradeProgressionSchema,
  climbingSessionSummarySchema,
  climbingVolumeByGradeSchema,
} from "../repositories/climbing-repository.ts";
import { ClimbingStrengthsRepository } from "../repositories/climbing-strengths-repository.ts";
import { ClimbingTrainingLogRepository } from "../repositories/climbing-training-log-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { buildClimbingLocationMap } from "../services/climbing-location-map.ts";
import { buildClimbingStrengths } from "../services/climbing-strengths.ts";
import {
  type AuthenticatedContext,
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  router,
} from "../trpc.ts";

const daysInputSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });
const climbingInputSchema = daysInputSchema.extend(climbingFiltersSchema.shape);
const climbingLogEntriesSchema = z.array(climbingLogEntryDetailResponseSchema);
const climbingGradeProgressionsSchema = z.array(climbingGradeProgressionSchema);
const climbingVolumesSchema = z.array(climbingVolumeByGradeSchema);
const climbingSessionSummariesSchema = z.array(climbingSessionSummarySchema);

const hangboardingSummarySchema = z.object({
  sessionCount: z.number().int().nonnegative(),
  totalDurationSeconds: z.number().nonnegative(),
  averageDurationSeconds: z.number().nullable(),
  totalWorkDurationSeconds: z.number().nullable(),
  totalRestDurationSeconds: z.number().nullable(),
  workIntervalCount: z.number().int().nonnegative().nullable(),
  averageHeartRate: z.number().nullable(),
  peakHeartRate: z.number().nullable(),
  latestSession: z
    .object({
      activityId: z.string(),
      startedAt: z.string(),
      planName: z.string().nullable(),
      boardName: z.string().nullable(),
      durationSeconds: z.number().nonnegative(),
    })
    .nullable(),
  daily: z.array(
    z.object({
      date: z.string(),
      sessionCount: z.number().int().nonnegative(),
      durationSeconds: z.number().nonnegative(),
      workDurationSeconds: z.number().nullable(),
      restDurationSeconds: z.number().nullable(),
    }),
  ),
});

async function createClimbingRepository(ctx: AuthenticatedContext): Promise<ClimbingRepository> {
  const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
  return new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow, preference);
}

async function runClimbingQuery<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error: unknown) {
    if (error instanceof TRPCError) throw error;
    captureException(error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to load climbing data",
      cause: error,
    });
  }
}

export const climbingRouter = router({
  catalogueContext: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .output(climbingCatalogueContextSchema)
    .query(({ ctx, input }) =>
      runClimbingQuery(() =>
        new ClimbingCatalogueRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow).read(
          input.id,
        ),
      ),
    ),
  refreshCatalogueContext: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .output(climbingCatalogueContextSchema)
    .mutation(({ ctx, input }) =>
      runClimbingQuery(() =>
        new ClimbingCatalogueRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
        ).requestRefresh(input.id),
      ),
    ),
  images: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .output(activityImagesOutputSchema)
    .query(async ({ ctx, input }) =>
      runClimbingQuery(() =>
        new ClimbingImagesRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow).getImages(
          input.id,
          { sign: createActivityImageUrl, readImage: readActivityImageObject },
        ),
      ),
    ),
  strengths: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingStrengthsSchema,
    keyVersion: "climbing-strengths-v9",
  })
    .input(
      climbingInputSchema.extend({
        days: z.number().int().min(1).max(365).nullable().default(90),
        endDate: z.iso.date().optional(),
      }),
    )
    .output(climbingStrengthsSchema)
    .query(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
        const repository = new ClimbingStrengthsRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          preference,
        );
        const endDate = input.endDate ?? formatDateYmdInTimeZone(new Date(), ctx.timezone);
        return buildClimbingStrengths(
          await repository.getObservations(input.days, input, endDate),
          {
            ...(input.days === null
              ? {}
              : { startDate: dateWindowStartString(endDate, input.days - 1) }),
            endDate,
          },
        );
      }),
    ),
  fingerLoadingHistory: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(daysInputSchema)
    .query(async ({ ctx, input }) => {
      const repository = new ClimbingTrainingLogRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      return repository.getFingerLoadingHistory(input.days);
    }),

  activityLogEntries: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingLogEntriesSchema,
    keyVersion: "climbing-activity-log-model-v7",
  })
    .input(z.object({ activityId: z.guid(), responseVersion: climbingResponseVersionSchema }))
    .output(climbingLogEntriesSchema)
    .query(async ({ ctx, input }) => {
      return runClimbingQuery(async () => {
        const activity = await new ActivityRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          ctx.sensorStore,
        ).findById(input.activityId);
        if (!activity) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
        }
        const repository = await createClimbingRepository(ctx);
        return (await repository.getActivityLogEntries(activity.id)).map((row) =>
          serializeClimbingLogEntryDetailResponse(row.toDetail(), input.responseVersion),
        );
      });
    }),

  unattachedClimbingLogEntries: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    outputSchema: climbingLogEntriesSchema,
    keyVersion: "climbing-log-suggestions-v7",
  })
    .input(z.object({ activityId: z.guid(), responseVersion: climbingResponseVersionSchema }))
    .output(climbingLogEntriesSchema)
    .query(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        const entries = await new ClimbingLogEntryAssociator(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
        ).getSuggestions(input.activityId);
        return entries.map((entry) =>
          serializeClimbingLogEntryDetailResponse(entry, input.responseVersion),
        );
      }),
    ),

  attachmentActivities: protectedProcedure
    .input(z.object({ date: z.iso.date() }))
    .output(z.array(climbingAttachmentActivitySchema))
    .query(async ({ ctx, input }) =>
      runClimbingQuery(() =>
        new ClimbingLogEntryAssociator(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
        ).getAttachmentActivities(input.date),
      ),
    ),

  attachClimbingLogEntry: protectedProcedure
    .input(z.object({ activityId: z.guid(), climbingLogEntryId: z.guid() }))
    .mutation(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        await new ClimbingLogEntryAssociator(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
        ).attachLogEntry(input);
        await Promise.all([
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.activityLogEntries:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.sessionSummary:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.gradeProgression:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.volumeByGrade:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.volumeOverTime:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.locationMap:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.strengths:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.unattachedClimbingLogEntries:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:activity.list:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:calendar.weekList:`),
        ]);
        return { attached: true as const };
      }),
    ),

  gradeProgression: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingGradeProgressionsSchema,
    keyVersion: "climbing-scoped-grade-lanes-v4",
  })
    .input(climbingInputSchema)
    .output(climbingGradeProgressionsSchema)
    .query(async ({ ctx, input }): Promise<ClimbingGradeProgressionRow[]> => {
      return runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return (await repository.getGradeProgression(input.days, input)).map((row) =>
          row.toDetail(),
        );
      });
    }),

  volumeByGrade: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingVolumesSchema,
    keyVersion: "climbing-canonical-log-observations-v4",
  })
    .input(climbingInputSchema)
    .output(climbingVolumesSchema)
    .query(async ({ ctx, input }): Promise<ClimbingVolumeByGradeRow[]> => {
      return runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return (await repository.getVolumeByGrade(input.days, input)).map((row) => row.toDetail());
      });
    }),

  volumeOverTime: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    keyVersion: "climbing-recorded-weekly-attempts-v1",
  })
    .input(
      climbingInputSchema.extend({ days: z.number().int().min(1).max(365).nullable().default(90) }),
    )
    .output(
      z.array(
        z.object({
          week: z.string(),
          attempts: z.number().nullable(),
          minutes: z.number().nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        const { days, ...filters } = input;
        return repository.getVolumeOverTime(days, filters);
      }),
    ),

  sessionSummary: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingSessionSummariesSchema,
    keyVersion: "climbing-canonical-log-sessions-v4",
  })
    .input(climbingInputSchema)
    .output(climbingSessionSummariesSchema)
    .query(async ({ ctx, input }): Promise<ClimbingSessionSummaryRow[]> => {
      return runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return (await repository.getSessionSummaries(input.days, input)).map((row) =>
          row.toDetail(),
        );
      });
    }),

  locationMap: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: climbingLocationMapSchema,
    keyVersion: "climbing-location-map-v4",
  })
    .input(climbingInputSchema)
    .output(climbingLocationMapSchema)
    .query(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return buildClimbingLocationMap(await repository.getMapEntries(input.days, input));
      }),
    ),

  hangboardingSummary: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    outputSchema: hangboardingSummarySchema,
    keyVersion: "hangboarding-sensor-heart-rate-v1",
  })
    .input(daysInputSchema)
    .output(hangboardingSummarySchema)
    .query(async ({ ctx, input }) => {
      const repository = new HangboardingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      return runClimbingQuery(() => repository.getSummary(input.days));
    }),
});
