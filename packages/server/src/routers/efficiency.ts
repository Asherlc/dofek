import { TRPCError } from "@trpc/server";
import { z } from "zod";
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

const polarizationTrendOutputSchema = z.object({
  model: z.literal("treff-three-zone"),
  activityScope: z.literal("cycling"),
  threshold: z.literal(2),
  maxHr: z.number().nullable(),
  weeks: z.array(
    z.object({
      week: z.string(),
      z1Seconds: z.number(),
      z2Seconds: z.number(),
      z3Seconds: z.number(),
      polarizationIndex: z.number().nullable(),
      totalSeconds: z.number(),
      zonePercentages: z.object({
        z1: z.number(),
        z2: z.number(),
        z3: z.number(),
      }),
      status: z.enum(["polarized", "not_polarized", "insufficient_data"]),
      statusLabel: z.string(),
      explanation: z.string(),
    }),
  ),
  explanation: z.string(),
  method: z.object({
    formula: z.string(),
    zoneBasis: z.string(),
    calculationChoice: z.string(),
    interpretation: z.string(),
    source: z.object({
      title: z.string(),
      url: z.url(),
    }),
  }),
}) satisfies z.ZodType<PolarizationTrendResult>;

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
   * PI = log10((f1 / f2) * f3 * 100); PI > 2.0 matches Treff's descriptive heuristic.
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
    { outputSchema: polarizationTrendOutputSchema },
  ),
});
