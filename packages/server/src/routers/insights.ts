import { TRPCError } from "@trpc/server";
import { selectedChartDateRangeInput } from "../lib/date-window.ts";
import { InsightsRepository } from "../repositories/insights-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const insightsRouter = router({
  compute: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(selectedChartDateRangeInput("insights.compute"))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "insights.compute requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
        });
      }

      const repo = new InsightsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.computeInsights(input.days, input.endDate);
    }),
});
