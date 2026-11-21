import { lateWorkoutSleepSchema } from "@dofek/training/late-workout-sleep";
import { z } from "zod";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import { LateWorkoutSleepRepository } from "../repositories/late-workout-sleep-repository.ts";
import { SleepRepository, sleepStageRowSchema } from "../repositories/sleep-repository.ts";

import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const stagesByDateSchema = z.object({
  date: z.iso.date().nullable(),
  stages: z.array(sleepStageRowSchema),
});

export const sleepRouter = router({
  lateWorkouts: selectedChartDateRangeQuery(
    "sleep.lateWorkouts",
    CacheTTL.MEDIUM,
    ({ ctx, input }) =>
      new LateWorkoutSleepRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      ).list(input),
    { outputSchema: lateWorkoutSleepSchema, scopeToAccessWindow: true },
  ),

  list: selectedChartDateRangeQuery(
    "sleep.list",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      const repo = new SleepRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return repo.list(range.days, input.endDate);
    },
  ),

  stages: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    outputSchema: z.array(sleepStageRowSchema),
  })
    .input(z.object({ sessionId: z.guid() }))
    .query(({ ctx, input }) => {
      const repo = new SleepRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return repo.getStages(input.sessionId);
    }),

  latestStages: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    outputSchema: z.array(sleepStageRowSchema),
  }).query(({ ctx }) => {
    const repo = new SleepRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
      ctx.sensorStore,
    );
    return repo.getLatestStages();
  }),

  stagesByDate: cachedProtectedQuery({ maxAge: CacheTTL.SHORT, outputSchema: stagesByDateSchema })
    .input(z.object({ date: z.iso.date().optional() }).optional())
    .output(stagesByDateSchema)
    .query(({ ctx, input }) => {
      const repo = new SleepRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return repo.getStagesByDate(input?.date);
    }),

  latest: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    const repo = new SleepRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
      ctx.sensorStore,
    );
    return repo.getLatest();
  }),
});
