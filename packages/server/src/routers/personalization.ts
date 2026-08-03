import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { PersonalizationRepository } from "../repositories/personalization-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    logger.error(`[personalization] ${feature} requires CLICKHOUSE_URL`);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Personalization is unavailable because activity analytics are not configured. Contact your administrator.",
    });
  }
  return sensorStore;
}

export const personalizationRouter = router({
  /** Current personalization status: learned params, effective params, and quality indicators */
  status: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM }).query(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.status");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    return repo.getStatus();
  }),

  /** Trigger an immediate refit of personalized parameters */
  refit: protectedProcedure.mutation(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.refit");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    const result = await repo.refit();
    await invalidateUserQueryDomains(ctx.userId, ["personalization"]);
    return result;
  }),

  /** Reset to defaults by deleting personalized params */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.reset");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    const result = await repo.reset();
    await invalidateUserQueryDomains(ctx.userId, ["personalization"]);
    return result;
  }),
});
