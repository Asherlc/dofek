import { TRPCError } from "@trpc/server";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { PersonalizationRepository } from "../repositories/personalization-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

export const personalizationRouter = router({
  /** Current personalization status: learned params, effective params, and quality indicators */
  status: cachedProtectedQuery(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.status");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    return repo.getStatus();
  }),

  /** Trigger an immediate refit of personalized parameters */
  refit: protectedProcedure.mutation(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.refit");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    return repo.refit();
  }),

  /** Reset to defaults by deleting personalized params */
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "personalization.reset");
    const repo = new PersonalizationRepository(ctx.db, ctx.userId, sensorStore);
    return repo.reset();
  }),
});
