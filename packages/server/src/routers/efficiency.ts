import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type AerobicDecouplingActivity,
  type AerobicEfficiencyResult,
  EfficiencyRepository,
  type PolarizationTrendResult,
} from "../repositories/efficiency-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type {
  AerobicDecouplingActivity,
  AerobicEfficiencyActivity,
  AerobicEfficiencyResult,
  PolarizationTrendResult,
  PolarizationWeek,
} from "../repositories/efficiency-repository.ts";

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

export const efficiencyRouter = router({
  aerobicEfficiency: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicEfficiencyResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.aerobicEfficiency");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getAerobicEfficiency(input.days);
    }),

  aerobicDecoupling: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicDecouplingActivity[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.aerobicDecoupling");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getAerobicDecoupling(input.days);
    }),

  /**
   * Polarization Index trend per week using Treff 3-zone model (%HRmax).
   *   Z1 (easy) = < 80% HRmax; Z2 (threshold) = 80-90%; Z3 (high) = >= 90%.
   * PI = log10((f1 / (f2 * f3)) * 100); PI > 2.0 indicates well-polarized training.
   */
  polarizationTrend: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PolarizationTrendResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.polarizationTrend");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getPolarizationTrend(input.days);
    }),
});
