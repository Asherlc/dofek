import { z } from "zod";
import { dateWindowInput } from "../lib/date-window.ts";
import { SleepRepository } from "../repositories/sleep-repository.ts";

import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const sleepRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const repo = new SleepRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.list(input.days, input.endDate);
    }),

  stages: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(({ ctx, input }) => {
      const repo = new SleepRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getStages(input.sessionId);
    }),

  latestStages: cachedProtectedQuery(CacheTTL.SHORT).query(({ ctx }) => {
    const repo = new SleepRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
    return repo.getLatestStages();
  }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new SleepRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
    return repo.getLatest();
  }),
});
