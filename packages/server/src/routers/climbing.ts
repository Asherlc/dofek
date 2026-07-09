import { z } from "zod";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface ClimbingGradeProgressionRow {
  date: string;
  climbType: "boulder" | "route";
  gradeSystem: "v_scale" | "yds" | "font" | "french";
  grade: string;
  gradeSortValue: number;
}

export interface ClimbingVolumeByGradeRow {
  climbType: "boulder" | "route";
  gradeSystem: "v_scale" | "yds" | "font" | "french";
  grade: string;
  gradeSortValue: number;
  attempts: number;
  sends: number;
}

export interface ClimbingSessionSummaryRow {
  activityId: string;
  date: string;
  name: string;
  locationName: string | null;
  attempts: number;
  sends: number;
  hardestBoulderGrade: string | null;
  hardestBoulderGradeSortValue: number | null;
  hardestRouteGrade: string | null;
  hardestRouteGradeSortValue: number | null;
}

const daysInputSchema = z.object({ days: z.number().default(90) });

export const climbingRouter = router({
  gradeProgression: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingGradeProgressionRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone);
      const rows = await repository.getGradeProgression(input.days);
      return rows.map((row) => row.toDetail());
    }),

  volumeByGrade: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingVolumeByGradeRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone);
      const rows = await repository.getVolumeByGrade(input.days);
      return rows.map((row) => row.toDetail());
    }),

  sessionSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(daysInputSchema)
    .query(async ({ ctx, input }): Promise<ClimbingSessionSummaryRow[]> => {
      const repository = new ClimbingRepository(ctx.db, ctx.userId, ctx.timezone);
      const rows = await repository.getSessionSummaries(input.days);
      return rows.map((row) => row.toDetail());
    }),
});
