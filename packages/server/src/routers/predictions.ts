import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { PredictionsRepository } from "../repositories/predictions-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

export const predictionsRouter = router({
  /** Available prediction targets */
  targets: cachedProtectedQuery({ maxAge: CacheTTL.LONG }).query(({ ctx }) => {
    const sensorStore = requireSensorStore(ctx.sensorStore, "predictions.targets");
    const repo = new PredictionsRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
    return repo.getTargets().map((target) => target.toDetail());
  }),

  /**
   * Train models for the given target. Handles both daily targets
   * (HRV, resting HR, sleep, weight) and activity-level targets
   * (cardio power, strength volume).
   */
  predict: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(
      z.object({
        target: z.string().default("hrv"),
        days: z.number().default(365),
      }),
    )
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "predictions.predict");
      const repo = new PredictionsRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      return repo.predict(input.target, input.days);
    }),
});
