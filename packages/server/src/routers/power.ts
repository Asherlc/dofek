import type { CriticalPowerModel } from "@dofek/training/power-analysis";
export type { CriticalPowerModel };

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PowerRepository } from "../repositories/power-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const powerRouter = router({
  powerCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getPowerCurve(input.days);
    }),
  eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getEftpTrend(input.days);
    }),
});
