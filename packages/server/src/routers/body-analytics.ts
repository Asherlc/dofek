import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export type {
  BodyRecompositionRow,
  SmoothedWeightRow,
  WeightPrediction,
} from "../repositories/body-analytics-repository.ts";

// ── Router ───────────────────────────────────────────────────────────

export const bodyAnalyticsRouter = router({
  smoothedWeight: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getSmoothedWeight(input.days, input.endDate);
    }),

  recomposition: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(180), endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getRecomposition(input.days, input.endDate);
    }),

  weightTrend: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({}).default({}))
    .query(({ ctx }) => {
      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getWeightTrend();
    }),

  weightPrediction: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }) => {
      const settingsRepo = new SettingsRepository(ctx.db, ctx.userId);
      const goalSetting = await settingsRepo.get("goalWeight");
      const parsedGoalWeightKg = goalSetting?.value != null ? Number(goalSetting.value) : null;
      const goalWeightKg =
        parsedGoalWeightKg != null && Number.isFinite(parsedGoalWeightKg)
          ? parsedGoalWeightKg
          : null;

      const repo = new BodyAnalyticsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getWeightPrediction(input.days, input.endDate, goalWeightKg);
    }),

  setGoalWeight: protectedProcedure
    .input(z.object({ weightKg: z.number().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      await repo.set("goalWeight", input.weightKg);
      await queryCache.invalidateByPrefix(`${ctx.userId}:bodyAnalytics.`);
      await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);
      return { goalWeightKg: input.weightKg };
    }),
});
