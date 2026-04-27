import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";
import { DISCONNECT_CHILD_TABLES } from "./provider-detail.ts";

export const settingsRouter = router({
  get: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      return repo.get(input.key);
    }),

  getAll: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    return repo.getAll();
  }),

  set: protectedProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      const result = await repo.set(input.key, input.value);

      // Invalidate server-side cache for settings.get and settings.getAll
      // so subsequent reads return the updated value, not stale cached data.
      await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);

      return result;
    }),

  slackStatus: cachedProtectedQuery(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    return repo.slackStatus();
  }),

  deleteAllUserData: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    await repo.deleteAllUserData(DISCONNECT_CHILD_TABLES);
    return { success: true };
  }),
});
