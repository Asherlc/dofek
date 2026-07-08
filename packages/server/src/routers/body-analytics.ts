import { captureException } from "@sentry/node";
import type { Database } from "dofek/db";
import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import {
  type AuthenticatedContext,
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  router,
} from "../trpc.ts";

async function readGoalWeightKg(db: Pick<Database, "execute" | "transaction">, userId: string) {
  try {
    const settingsRepo = new SettingsRepository(db, userId);
    const goalSetting = await settingsRepo.get("goalWeight");
    const parsedGoalWeightKg = goalSetting?.value != null ? Number(goalSetting.value) : null;
    return parsedGoalWeightKg != null && Number.isFinite(parsedGoalWeightKg)
      ? parsedGoalWeightKg
      : null;
  } catch (error) {
    captureException(error);
    return null;
  }
}

export type {
  BodyRecompositionRow,
  SmoothedWeightRow,
  WeightPrediction,
} from "../repositories/body-analytics-repository.ts";

const dateWindowInput = z.object({ days: z.number().default(90), endDate: endDateSchema });

function createBodyAnalyticsRepository(ctx: AuthenticatedContext) {
  return new BodyAnalyticsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.accessWindow,
    ctx.sensorStore,
  );
}

// ── Router ───────────────────────────────────────────────────────────

export const bodyAnalyticsRouter = router({
  smoothedWeight: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(dateWindowInput)
    .query(({ ctx, input }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getSmoothedWeight(input.days, input.endDate);
    }),

  weightOverview: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const goalWeightKg = await readGoalWeightKg(ctx.db, ctx.userId);
      const repo = createBodyAnalyticsRepository(ctx);
      const [smoothedWeightResult, predictionResult] = await Promise.allSettled([
        repo.getSmoothedWeight(input.days, input.endDate),
        repo.getWeightPrediction(input.days, input.endDate, goalWeightKg),
      ]);

      if (smoothedWeightResult.status === "rejected") {
        throw smoothedWeightResult.reason;
      }

      if (predictionResult.status === "rejected") {
        captureException(predictionResult.reason);
      }

      return {
        smoothedWeight: smoothedWeightResult.value,
        prediction: predictionResult.status === "fulfilled" ? predictionResult.value : null,
      };
    }),

  recomposition: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ days: z.number().default(180), endDate: endDateSchema }))
    .query(({ ctx, input }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getRecomposition(input.days, input.endDate);
    }),

  weightTrend: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({}).default({}))
    .query(({ ctx }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getWeightTrend();
    }),

  weightPrediction: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const goalWeightKg = await readGoalWeightKg(ctx.db, ctx.userId);
      const repo = createBodyAnalyticsRepository(ctx);
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
