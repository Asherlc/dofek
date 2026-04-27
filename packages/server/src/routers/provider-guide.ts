import { PROVIDER_GUIDE_SETTINGS_KEY } from "@dofek/onboarding/provider-guide";
import { queryCache } from "dofek/lib/cache";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export { PROVIDER_GUIDE_SETTINGS_KEY };

export const providerGuideRouter = router({
  status: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    const setting = await repo.get(PROVIDER_GUIDE_SETTINGS_KEY);
    return { dismissed: setting?.value === true };
  }),

  dismiss: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    await repo.set(PROVIDER_GUIDE_SETTINGS_KEY, true);
    await queryCache.invalidateByPrefix(`${ctx.userId}:providerGuide.`);
    return { dismissed: true };
  }),
});
