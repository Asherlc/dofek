import { TRPCError } from "@trpc/server";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import {
  type ClimbingActivityEntryRow,
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
} from "../repositories/climbing-repository.ts";
import { ClimbingTrainingLogRepository } from "../repositories/climbing-training-log-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const daysInputSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });
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

  activityEntries: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<ClimbingActivityEntryRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const rows = await runClimbingQuery(() => repository.getActivityEntries(input.id));
      return rows.map((row) => row.toDetail());
    }),

  gradeProgression: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingGradeProgressionRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const rows = await runClimbingQuery(() => repository.getGradeProgression(input.days));
      return rows.map((row) => row.toDetail());
    }),

  volumeByGrade: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingVolumeByGradeRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const rows = await runClimbingQuery(() => repository.getVolumeByGrade(input.days));
      return rows.map((row) => row.toDetail());
    }),

  sessionSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingSessionSummaryRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const rows = await runClimbingQuery(() => repository.getSessionSummaries(input.days));
      return rows.map((row) => row.toDetail());
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
