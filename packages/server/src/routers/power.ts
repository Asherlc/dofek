import type { CriticalPowerModel } from "@dofek/training/power-analysis";
export type { CriticalPowerModel };

import { TRPCError } from "@trpc/server";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export const powerRouter = router({
  powerCurve: selectedChartRangeQuery("power.powerCurve", CacheTTL.LONG, async ({ ctx, range }) => {
    if (!ctx.sensorStore) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
      });
    }
    const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore, ctx.db);
    return repo.getPowerCurve(range);
  }),
  eftpTrend: selectedChartRangeQuery("power.eftpTrend", CacheTTL.LONG, async ({ ctx, range }) => {
    if (!ctx.sensorStore) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
      });
    }
    const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore, ctx.db);
    return repo.getEftpTrend(range);
  }),
});
