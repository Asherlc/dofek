import { z } from "zod";
import { selectedChartCustomRangeQuery, selectedChartRangeSchema } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
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

const correlationDataPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  date: dateStringSchema,
});

const correlationStatsSchema = z.object({
  mean: z.number(),
  median: z.number(),
  stddev: z.number(),
  min: z.number(),
  max: z.number(),
  n: z.number().int().nonnegative(),
});

const correlationResultBaseShape = {
  dataPoints: z.array(correlationDataPointSchema),
  sampleCount: z.number().int().nonnegative(),
  insight: z.string(),
  correlationColor: z.string(),
};

const correlationComputeOutputSchema = z.discriminatedUnion("availability", [
  z.object({
    ...correlationResultBaseShape,
    availability: z.literal("insufficient"),
    sampleCount: z.number().int().min(0).max(4),
    additionalSamplesRequired: z.number().int().min(1).max(5),
    confidenceLevel: z.literal("insufficient"),
  }),
  z.object({
    ...correlationResultBaseShape,
    availability: z.literal("available"),
    sampleCount: z.number().int().min(5),
    spearmanRho: z.number(),
    spearmanPValue: z.number(),
    pearsonR: z.number(),
    pearsonPValue: z.number(),
    regression: z.object({
      slope: z.number(),
      intercept: z.number(),
      rSquared: z.number(),
    }),
    xStats: correlationStatsSchema,
    yStats: correlationStatsSchema,
    confidenceLevel: z.enum(["strong", "emerging", "early", "insufficient"]),
  }),
]);

// ── tRPC Router ─────────────────────────────────────────────────────────

export const correlationRouter = router({
  metrics: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
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
    correlationComputeOutputSchema,
  ),
});
