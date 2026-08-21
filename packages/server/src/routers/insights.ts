import { TRPCError } from "@trpc/server";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import { InsightsRepository } from "../repositories/insights-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export const insightsRouter = router({
  compute: selectedChartDateRangeQuery(
    "insights.compute",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "insights.compute requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
        });
      }

      const repo = new InsightsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.computeInsights(range.days, input.endDate);
    },
    { keyVersion: "insights-evidence-v1" },
  ),
});
