import {
  CLIMBING_GRADE_SYSTEMS,
  gradeSystemLabel,
  isGradeSystemForClimbType,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import { TRPCError } from "@trpc/server";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import {
  type ClimbingActivityEntryRow,
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
} from "../repositories/climbing-repository.ts";
import {
  ClimbingTrainingLogRepository,
  climbingAttemptOutcomeSchema,
  climbingFailureReasonSchema,
  climbingHoldTypeSchema,
  fingerLoadingExerciseSchema,
  fingerLoadingGripPositionSchema,
  fingerLoadingLateralitySchema,
} from "../repositories/climbing-training-log-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const daysInputSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });
const nullableNoteSchema = z.string().trim().min(1).max(500).nullable().default(null);
const fingerLoadingInputSchema = z
  .object({
    bodyweightKg: z.number().positive().max(500),
    edgeSizeMm: z.number().positive().max(100).nullable().default(null),
    exercise: fingerLoadingExerciseSchema,
    externalLoadKg: z.number().min(-500).max(500),
    gripPosition: fingerLoadingGripPositionSchema.nullable().default(null),
    holdDurationSeconds: z.number().positive().max(600),
    laterality: fingerLoadingLateralitySchema,
    notes: nullableNoteSchema,
    restIntervalSeconds: z.number().int().min(0).max(3_600),
    rpe: z.number().min(0).max(10).nullable().default(null),
    setCount: z.number().int().min(1).max(100),
    startedAt: z.iso.datetime(),
  })
  .refine((protocol) => protocol.bodyweightKg + protocol.externalLoadKg > 0, {
    message: "Effective load must be greater than zero",
    path: ["externalLoadKg"],
  });
const climbingAttemptInputSchema = z
  .object({
    failureReason: climbingFailureReasonSchema.nullable().default(null),
    notes: nullableNoteSchema,
    outcome: climbingAttemptOutcomeSchema,
  })
  .superRefine((attempt, context) => {
    if (attempt.outcome === "sent" && attempt.failureReason !== null) {
      context.addIssue({
        code: "custom",
        message: "A sent attempt cannot have a failure reason",
        path: ["failureReason"],
      });
    }
    if (attempt.outcome === "failed" && attempt.failureReason === null) {
      context.addIssue({
        code: "custom",
        message: "A failed attempt requires a failure reason",
        path: ["failureReason"],
      });
    }
  });
const climbingSessionInputSchema = z
  .object({
    climbs: z
      .array(
        z
          .object({
            attempts: z.array(climbingAttemptInputSchema).min(1).max(100),
            climbType: z.enum(["boulder", "route"]),
            grade: z.string().trim().min(1).max(20),
            gradeSystem: z.enum(CLIMBING_GRADE_SYSTEMS),
            holdType: climbingHoldTypeSchema.nullable().default(null),
            routeName: z.string().trim().min(1).max(200).nullable().default(null),
            wallAngleDegrees: z.number().min(-90).max(90).nullable().default(null),
          })
          .superRefine((climb, context) => {
            if (!isGradeSystemForClimbType(climb.gradeSystem, climb.climbType)) {
              context.addIssue({
                code: "custom",
                message: "Grade system must match the climb type",
                path: ["gradeSystem"],
              });
              return;
            }
            if (!isValidClimbingGrade(climb.grade, climb.gradeSystem)) {
              context.addIssue({
                code: "custom",
                message: `"${climb.grade}" is not a valid ${gradeSystemLabel(climb.gradeSystem)} grade`,
                path: ["grade"],
              });
            }
          }),
      )
      .min(1)
      .max(30),
    endedAt: z.iso.datetime().nullable().default(null),
    locationName: z.string().trim().min(1).max(200).nullable().default(null),
    startedAt: z.iso.datetime(),
  })
  .refine(
    (session) =>
      session.endedAt === null ||
      new Date(session.endedAt).getTime() >= new Date(session.startedAt).getTime(),
    {
      message: "Session end time cannot be before its start time",
      path: ["endedAt"],
    },
  );

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

async function runClimbingMutation<T>(input: {
  message: string;
  mutation: () => Promise<T>;
  procedure: string;
}): Promise<T> {
  try {
    return await input.mutation();
  } catch (error: unknown) {
    if (error instanceof TRPCError) throw error;
    captureException(error, {
      tags: { procedure: input.procedure },
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: input.message,
      cause: error,
    });
  }
}

export const climbingRouter = router({
  logFingerLoading: protectedProcedure
    .input(fingerLoadingInputSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new ClimbingTrainingLogRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      const created = await runClimbingMutation({
        message: "Could not save the finger-loading session. Try again.",
        mutation: () => repository.logFingerLoading(input),
        procedure: "climbing.logFingerLoading",
      });
      await invalidateAllUserQueries(ctx.userId);
      return created;
    }),

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

  logClimbingSession: protectedProcedure
    .input(climbingSessionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new ClimbingTrainingLogRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      const created = await runClimbingMutation({
        message: "Could not save the climbing session. Try again.",
        mutation: () => repository.logClimbingSession(input),
        procedure: "climbing.logClimbingSession",
      });
      await invalidateAllUserQueries(ctx.userId);
      return created;
    }),

  activityEntries: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<ClimbingActivityEntryRow[]> => {
      return runClimbingQuery(async () => {
        const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
        const repository = new ClimbingRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          preference,
        );
        return (await repository.getActivityEntries(input.id)).map((row) => row.toDetail());
      });
    }),

  gradeProgression: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingGradeProgressionRow[]> => {
      return runClimbingQuery(async () => {
        const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
        const repository = new ClimbingRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          preference,
        );
        return (await repository.getGradeProgression(input.days)).map((row) => row.toDetail());
      });
    }),

  volumeByGrade: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingVolumeByGradeRow[]> => {
      return runClimbingQuery(async () => {
        const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
        const repository = new ClimbingRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          preference,
        );
        return (await repository.getVolumeByGrade(input.days)).map((row) => row.toDetail());
      });
    }),

  sessionSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingSessionSummaryRow[]> => {
      return runClimbingQuery(async () => {
        const preference = await loadClimbingGradePreference(ctx.db, ctx.userId);
        const repository = new ClimbingRepository(
          ctx.db,
          ctx.userId,
          ctx.timezone,
          ctx.accessWindow,
          preference,
        );
        return (await repository.getSessionSummaries(input.days)).map((row) => row.toDetail());
      });
    }),

  hangboardingSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
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
