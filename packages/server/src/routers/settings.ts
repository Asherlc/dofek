import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const dashboardLayoutSchema = z.strictObject({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  collapsed: z.record(z.string(), z.boolean()),
});

const settingInputSchema = z.discriminatedUnion("key", [
  z.strictObject({
    key: z.literal("dashboardLayout"),
    value: dashboardLayoutSchema,
  }),
  z.strictObject({
    key: z.literal("unitSystem"),
    value: z.enum(["metric", "imperial"]),
  }),
  z.strictObject({
    key: z.literal("whoop.wearLocation"),
    value: z.enum(["wrist", "bicep", "chest", "waist", "calf"]),
  }),
]);

export const settingsRouter = router({
  get: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      return repo.get(input.key);
    }),

  getAll: cachedProtectedQuery({ maxAge: CacheTTL.LONG }).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    return repo.getAll();
  }),

  set: protectedProcedure.input(settingInputSchema).mutation(async ({ ctx, input }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    const result = await repo.set(input.key, input.value);

    // Invalidate server-side cache for settings.get and settings.getAll
    // so subsequent reads return the updated value, not stale cached data.
    await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);

    return result;
  }),

  slackStatus: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM }).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    return repo.slackStatus();
  }),
});
