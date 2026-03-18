import { DEFAULT_PARAMS, getEffectiveParams } from "dofek/personalization/params";
import { refitAllParams } from "dofek/personalization/refit";
import { loadPersonalizedParams, SETTINGS_KEY } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { CacheTTL, cachedProtectedQueryLight, protectedProcedure, router } from "../trpc.ts";

export const personalizationRouter = router({
  /** Current personalization status: learned params, effective params, and quality indicators */
  status: cachedProtectedQueryLight(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    const stored = await loadPersonalizedParams(ctx.db, ctx.userId);
    const effective = getEffectiveParams(stored);

    return {
      isPersonalized:
        stored !== null &&
        (stored.ewma !== null ||
          stored.readinessWeights !== null ||
          stored.sleepTarget !== null ||
          stored.stressThresholds !== null ||
          stored.trimpConstants !== null),
      fittedAt: stored?.fittedAt ?? null,
      defaults: DEFAULT_PARAMS,
      effective,
      parameters: {
        ewma: stored?.ewma ?? null,
        readinessWeights: stored?.readinessWeights ?? null,
        sleepTarget: stored?.sleepTarget ?? null,
        stressThresholds: stored?.stressThresholds ?? null,
        trimpConstants: stored?.trimpConstants ?? null,
      },
    };
  }),

  /** Trigger an immediate refit of personalized parameters */
  refit: protectedProcedure.mutation(async ({ ctx }) => {
    const params = await refitAllParams(ctx.db, ctx.userId);
    const effective = getEffectiveParams(params);

    return {
      fittedAt: params.fittedAt,
      effective,
      parameters: {
        ewma: params.ewma,
        readinessWeights: params.readinessWeights,
        sleepTarget: params.sleepTarget,
        stressThresholds: params.stressThresholds,
        trimpConstants: params.trimpConstants,
      },
    };
  }),

  /** Reset to defaults by deleting personalized params */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.execute(
      sql`DELETE FROM fitness.user_settings
          WHERE user_id = ${ctx.userId} AND key = ${SETTINGS_KEY}`,
    );
    return { effective: DEFAULT_PARAMS };
  }),
});
