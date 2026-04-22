import { z } from "zod";
import { RunningRepository } from "../repositories/running-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface RunningDynamicsRow {
  activityId: string;
  date: string;
  activityName: string;
  cadence: number;
  strideLengthMeters: number | null;
  stanceTimeMs: number | null;
  verticalOscillationMm: number | null;
  paceSecondsPerKm: number;
  distanceKm: number;
}

export interface PaceTrendRow {
  date: string;
  activityName: string;
  paceSecondsPerKm: number;
  distanceKm: number;
  durationMinutes: number;
}

const daysInput = z.object({ days: z.number().default(90) });

export const runningRouter = router({
  dynamics: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone);
      return (await repo.getDynamics(input.days)).map((activity) => activity.toDetail());
    }),

  paceTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      const repo = new RunningRepository(ctx.db, ctx.userId, ctx.timezone);
      return (await repo.getPaceTrend(input.days)).map((activity) => activity.toDetail());
    }),
});
