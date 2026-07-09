import type { CriticalPowerModel } from "@dofek/training/power-analysis";
export type { CriticalPowerModel };

import { TRPCError } from "@trpc/server";
import { selectedChartRangeInput } from "../lib/date-window.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const powerRouter = router({
  powerCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(selectedChartRangeInput("power.powerCurve"))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore, ctx.db);
      return repo.getPowerCurve(input.days);
    }),
  eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(selectedChartRangeInput("power.eftpTrend"))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore, ctx.db);
      return repo.getEftpTrend(input.days);
    }),
});
