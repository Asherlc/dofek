import { TRPCError } from "@trpc/server";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type AerobicDecouplingActivity,
  type AerobicEfficiencyResult,
  EfficiencyRepository,
  type PolarizationTrendResult,
} from "../repositories/efficiency-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

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
  aerobicEfficiency: selectedChartRangeQuery(
    "efficiency.aerobicEfficiency",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<AerobicEfficiencyResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.aerobicEfficiency");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getAerobicEfficiency(range);
    },
  ),

  aerobicDecoupling: selectedChartRangeQuery(
    "efficiency.aerobicDecoupling",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<AerobicDecouplingActivity[]> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.aerobicDecoupling");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getAerobicDecoupling(range);
    },
  ),

  /**
   * Polarization Index trend per week using Treff 3-zone model (%HRmax).
   *   Z1 (easy) = < 80% HRmax; Z2 (threshold) = 80-90%; Z3 (high) = >= 90%.
   * PI = log10((f1 / (f2 * f3)) * 100); PI > 2.0 indicates well-polarized training.
   */
  polarizationTrend: selectedChartRangeQuery(
    "efficiency.polarizationTrend",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<PolarizationTrendResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "efficiency.polarizationTrend");
      const repo = new EfficiencyRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getPolarizationTrend(range);
    },
  ),
});
