import { z } from "zod";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import { SleepRepository } from "../repositories/sleep-repository.ts";

import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const sleepRouter = router({
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

  stages: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
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

  latestStages: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(({ ctx }) => {
    const repo = new SleepRepository(
      ctx.db,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
      ctx.sensorStore,
    );
    return repo.getLatestStages();
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
