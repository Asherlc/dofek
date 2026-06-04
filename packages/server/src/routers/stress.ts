import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import {
  type DailyStressRow,
  StressRepository,
  type StressResult,
  type WeeklyStressRow,
} from "../repositories/stress-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { DailyStressRow, StressResult, WeeklyStressRow };

export const stressRouter = router({
  /**
   * Stress Monitor — daily stress scores from HR/HRV deviation against personal baselines.
   * Mirrors Whoop's 0-3 stress scale with cumulative weekly tracking.
   */
  scores: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().min(1).max(365).default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StressResult> => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "stress.scores requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
        });
      }

      return new StressRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      ).getStressScores(input.days, input.endDate);
    }),
});
