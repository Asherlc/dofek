import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  type ClimbingGradeProgressionRow,
  ClimbingRepository,
  type ClimbingSessionSummaryRow,
  type ClimbingVolumeByGradeRow,
} from "../repositories/climbing-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const daysInputSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });

async function runClimbingQuery<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error: unknown) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to load climbing data",
      cause: error,
    });
  }
}

export const climbingRouter = router({
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
});
