import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
export type { PmcChartResult, PmcDataPoint, TssModelInfo };

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { PmcRepository } from "../repositories/pmc-repository.ts";
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

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Reads activities + Normalized Power from ClickHouse analytics tables.
   * Computes daily TSS using a learned regression model (power+HR paired activities)
   * when available, falling back to generic Bannister TRIMP normalization.
   * Derives CTL (42d), ATL (7d), TSB from daily TSS.
   */
  chart: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PmcChartResult> => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "pmc.chart");
      const repo = new PmcRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getChart(input.days);
    }),
});
