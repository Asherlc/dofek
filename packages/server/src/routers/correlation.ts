import { z } from "zod";
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
      const repo = new CorrelationRepository(ctx.db, ctx.userId);
      return repo.getMetrics();
    }),

  compute: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        metricX: z.string(),
        metricY: z.string(),
        days: z.number().default(365),
        lag: z.number().min(0).max(7).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new CorrelationRepository(ctx.db, ctx.userId);
      return repo.compute(input.metricX, input.metricY, input.days, input.lag, "");
    }),
});
