import { z } from "zod";
import { selectedChartCustomRangeQuery, selectedChartRangeSchema } from "../lib/chart-range.ts";
import {
  CorrelationRepository,
  computeCorrelation,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "../repositories/correlation-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// Re-export helpers for backward compatibility
export { extractMetricValue, downsample, computeCorrelation, computeStats, emptyStats };
export type { CorrelationInput } from "../repositories/correlation-repository.ts";

// ── tRPC Router ─────────────────────────────────────────────────────────

export const correlationRouter = router({
  metrics: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({}).optional())
    .query(({ ctx }) => {
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getMetrics();
    }),

  compute: selectedChartCustomRangeQuery(
    "correlation.compute",
    CacheTTL.MEDIUM,
    z.object({
      metricX: z.string(),
      metricY: z.string(),
      days: selectedChartRangeSchema("correlation.compute"),
      lag: z.number().min(0).max(7).default(0),
    }),
    async ({ ctx, input, range }) => {
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.compute(
        input.metricX,
        input.metricY,
        range.days,
        input.lag,
        new Date().toISOString().slice(0, 10),
      );
    },
  ),
});
