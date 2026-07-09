import { z } from "zod";
import { selectedChartDateRangeInput } from "../lib/date-window.ts";
import { SleepRepository } from "../repositories/sleep-repository.ts";

import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const sleepRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartDateRangeInput("sleep.list"))
    .query(async ({ ctx, input }) => {
      const repo = new SleepRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return repo.list(input.days, input.endDate);
    }),

  stages: cachedProtectedQuery(CacheTTL.MEDIUM)
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

  latestStages: cachedProtectedQuery(CacheTTL.SHORT).query(({ ctx }) => {
    const repo = new SleepRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
      ctx.sensorStore,
    );
    return repo.getLatestStages();
  }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
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
