import { TRPCError } from "@trpc/server";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import {
  type DailyStressRow,
  StressRepository,
  type StressResult,
  type WeeklyStressRow,
} from "../repositories/stress-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export type { DailyStressRow, StressResult, WeeklyStressRow };

export const stressRouter = router({
  /**
   * Stress Monitor — daily stress scores from HR/HRV deviation against personal baselines.
   * Mirrors Whoop's 0-3 stress scale with cumulative weekly tracking.
   */
  scores: selectedChartDateRangeQuery(
    "stress.scores",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }): Promise<StressResult> => {
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
      ).getStressScores(range.days, input.endDate);
    },
    { min: 1, max: 365 },
  ),
});
