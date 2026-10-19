import { climbingFiltersSchema } from "@dofek/training/climbing-filters";
import { climbingLocationMapSchema } from "@dofek/training/climbing-location-map";
import { TRPCError } from "@trpc/server";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import {
  climbingAttachmentActivitySchema,
  climbingLogEntryDetailSchema,
} from "../contracts/climbing-log-contracts.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingLogEntryAssociator } from "../repositories/climbing-log-entry-associator.ts";
import {
  type ClimbingGradeProgressionRow,
  type ClimbingLogEntryDetail,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
  climbingGradeProgressionSchema,
  climbingSessionSummarySchema,
  climbingVolumeByGradeSchema,
} from "../repositories/climbing-repository.ts";
import { ClimbingTrainingLogRepository } from "../repositories/climbing-training-log-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { buildClimbingLocationMap } from "../services/climbing-location-map.ts";
import {
  type AuthenticatedContext,
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  router,
} from "../trpc.ts";

const daysInputSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });
const climbingInputSchema = daysInputSchema.extend(climbingFiltersSchema.shape);
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
    keyVersion: "climbing-activity-log-model-v2",
  })
    .input(z.object({ activityId: z.guid() }))
    .output(z.array(climbingLogEntryDetailSchema))
    .query(async ({ ctx, input }): Promise<ClimbingLogEntryDetail[]> => {
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
        return (await repository.getActivityLogEntries(activity.id)).map((row) => row.toDetail());
      });
    }),

  unattachedClimbingLogEntries: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    keyVersion: "climbing-log-suggestions-v2",
  })
    .input(z.object({ activityId: z.guid() }))
    .output(z.array(climbingLogEntryDetailSchema))
    .query(async ({ ctx, input }) =>
      runClimbingQuery(() =>
        new ClimbingLogEntryAssociator(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
        ).getSuggestions(input.activityId),
      ),
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
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.locationMap:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:climbing.unattachedClimbingLogEntries:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:activity.list:`),
          queryCache.invalidateByPrefix(`${ctx.userId}:calendar.weekList:`),
        ]);
        return { attached: true as const };
      }),
    ),

  gradeProgression: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    keyVersion: "climbing-scoped-grade-lanes-v1",
  })
    .input(climbingInputSchema)
    .output(z.array(climbingGradeProgressionSchema))
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
    keyVersion: "climbing-canonical-log-observations-v1",
  })
    .input(climbingInputSchema)
    .output(z.array(climbingVolumeByGradeSchema))
    .query(async ({ ctx, input }): Promise<ClimbingVolumeByGradeRow[]> => {
      return runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return (await repository.getVolumeByGrade(input.days, input)).map((row) => row.toDetail());
      });
    }),

  sessionSummary: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    keyVersion: "climbing-canonical-log-sessions-v1",
  })
    .input(climbingInputSchema)
    .output(z.array(climbingSessionSummarySchema))
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
    keyVersion: "climbing-location-map-v1",
  })
    .input(climbingInputSchema)
    .output(climbingLocationMapSchema)
    .query(async ({ ctx, input }) =>
      runClimbingQuery(async () => {
        const repository = await createClimbingRepository(ctx);
        return buildClimbingLocationMap(await repository.getMapEntries(input.days, input));
      }),
    ),

  hangboardingSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .output(hangboardingSummarySchema)
    .query(async ({ ctx, input }) => {
      const repository = new HangboardingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      return runClimbingQuery(() => repository.getSummary(input.days));
    }),
});
