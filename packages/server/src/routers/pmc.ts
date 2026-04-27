import type { PmcChartResult, PmcDataPoint, TssModelInfo } from "@dofek/training/pmc";
export type { PmcChartResult, PmcDataPoint, TssModelInfo };

import { z } from "zod";
import { PmcRepository } from "../repositories/pmc-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const pmcRouter = router({
  /**
   * Performance Management Chart data.
   * Reads from activity_summary rollup + user_profile for max_hr.
   * Computes daily TSS using a learned regression model (power+HR paired activities)
   * when available, falling back to generic Bannister TRIMP normalization.
   * Derives CTL (42d), ATL (7d), TSB from daily TSS.
   */
  chart: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PmcChartResult> => {
      const repo = new PmcRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getChart(input.days);
    }),
});
