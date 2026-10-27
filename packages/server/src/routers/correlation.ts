import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { MIN_CORRELATION_PAIRS } from "@dofek/stats/correlation";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { epistemicStatusSchema } from "../contracts/epistemic-status-contract.ts";
import { selectedChartCustomRangeQuery, selectedChartRangeSchema } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import {
  CorrelationRepository,
  computeCorrelation,
  computeCorrelationV2,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "../repositories/correlation-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { CorrelationInput } from "../repositories/correlation-repository.ts";
// Re-export helpers for backward compatibility
export {
  computeCorrelation,
  computeCorrelationV2,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
};

const correlationDataPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  date: dateStringSchema,
});

const correlationContributorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    label: z.string(),
    providerIds: z.array(z.string()),
    target: z.object({
      type: z.literal("activity"),
      activityId: z.guid(),
    }),
  }),
  z.object({
    kind: z.literal("aggregate_inputs"),
    label: z.string(),
    providerIds: z.array(z.string()),
    target: z.object({
      type: z.literal("metric_family"),
      family: z.enum(["recovery", "sleep", "nutrition", "activity", "body"]),
    }),
  }),
]);

const correlationObservationValueSchema = z.object({
  metricId: z.string(),
  date: dateStringSchema,
  value: z.number(),
  contributors: z.array(correlationContributorSchema),
});

const correlationObservationPageSchema = z.object({
  items: z.array(
    z.object({
      x: correlationObservationValueSchema,
      y: correlationObservationValueSchema,
    }),
  ),
  totalCount: z.number().int().nonnegative(),
  nextCursor: dateStringSchema.nullable(),
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
  epistemicStatus: epistemicStatusSchema,
  dataPoints: z.array(correlationDataPointSchema),
  sampleCount: z.number().int().nonnegative(),
  insight: z.string(),
  correlationColor: z.string(),
};

const correlationComputeOutputSchema = z.discriminatedUnion("availability", [
  z.object({
    ...correlationResultBaseShape,
    availability: z.literal("insufficient"),
    sampleCount: z
      .number()
      .int()
      .min(0)
      .max(MIN_CORRELATION_PAIRS - 1),
    additionalSamplesRequired: z.number().int().min(1).max(MIN_CORRELATION_PAIRS),
    confidenceLevel: z.literal("insufficient"),
  }),
  z.object({
    ...correlationResultBaseShape,
    availability: z.literal("available"),
    sampleCount: z.number().int().min(MIN_CORRELATION_PAIRS),
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

const correlationCoverageSchema = z.object({
  selectedDayCount: z.number().int().nonnegative(),
  eligiblePairDayCount: z.number().int().nonnegative(),
  observedXDayCount: z.number().int().nonnegative(),
  observedYDayCount: z.number().int().nonnegative(),
  pairedDayCount: z.number().int().nonnegative(),
  missingPairDayCount: z.number().int().nonnegative(),
});

const correlationUncertaintyBaseShape = {
  method: z.literal("circular_moving_block_bootstrap"),
  level: z.literal(0.95),
  blockLength: z.number().int().nonnegative(),
  requestedReplicateCount: z.literal(2_000),
  attemptedReplicateCount: z.number().int().nonnegative(),
  validReplicateCount: z.number().int().nonnegative(),
};

const correlationUncertaintySchema = z.discriminatedUnion("availability", [
  z.object({
    ...correlationUncertaintyBaseShape,
    availability: z.literal("available"),
    lower: z.number().min(-1).max(1),
    upper: z.number().min(-1).max(1),
  }),
  z.object({
    ...correlationUncertaintyBaseShape,
    availability: z.literal("unavailable"),
    reason: z.enum([
      "empty_input",
      "degenerate_input",
      "insufficient_pairs",
      "insufficient_valid_replicates",
    ]),
  }),
]);

const correlationV2BaseShape = {
  epistemicStatus: epistemicStatusSchema,
  analysisVersion: z.literal(2),
  dataPoints: z.array(correlationDataPointSchema),
  sampleCount: z.number().int().nonnegative(),
  coverage: correlationCoverageSchema,
  uncertainty: correlationUncertaintySchema,
  insight: z.string(),
  interpretationWarning: z.string(),
};

const correlationComputeV2OutputSchema = z.discriminatedUnion("availability", [
  z.object({
    ...correlationV2BaseShape,
    availability: z.literal("insufficient"),
    sampleCount: z
      .number()
      .int()
      .min(0)
      .max(MIN_CORRELATION_PAIRS - 1),
    additionalSamplesRequired: z.number().int().min(1).max(MIN_CORRELATION_PAIRS),
  }),
  z.object({
    ...correlationV2BaseShape,
    availability: z.literal("available"),
    sampleCount: z.number().int().min(MIN_CORRELATION_PAIRS),
    spearmanRho: z.number().min(-1).max(1).nullable(),
    regression: z.object({
      slope: z.number().nullable(),
      intercept: z.number().nullable(),
      rSquared: z.number().nullable(),
    }),
    xStats: correlationStatsSchema,
    yStats: correlationStatsSchema,
  }),
]);

function correlationInputSchema(endpoint: "correlation.compute" | "correlation.computeV2") {
  return z.object({
    metricX: z.string(),
    metricY: z.string(),
    days: selectedChartRangeSchema(endpoint),
    lag: z.number().min(0).max(7).default(0),
  });
}

function assertDistinctMetrics(metricX: string, metricY: string): void {
  if (metricX === metricY) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose two different metrics to compare.",
    });
  }
}

const correlationObservationsInputSchema = z.object({
  metricX: z.string(),
  metricY: z.string(),
  days: selectedChartRangeSchema("correlation.observations"),
  lag: z.number().min(0).max(7).default(0),
  cursor: dateStringSchema.optional(),
  pageSize: z.number().int().min(1).max(100).default(25),
});

function currentCorrelationEndDate(timezone: string): string {
  return formatDateYmdInTimeZone(new Date(), timezone);
}

// ── tRPC Router ─────────────────────────────────────────────────────────

export const correlationRouter = router({
  metrics: cachedProtectedQuery({ maxAge: CacheTTL.LONG, keyVersion: "correlation.metrics:v2" })
    .input(z.object({}).optional())
    .query(({ ctx }) => {
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getMetrics();
    }),

  compute: selectedChartCustomRangeQuery(
    "correlation.compute",
    CacheTTL.MEDIUM,
    correlationInputSchema("correlation.compute"),
    async ({ ctx, input, range }) => {
      assertDistinctMetrics(input.metricX, input.metricY);
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.compute(
        input.metricX,
        input.metricY,
        range.days,
        input.lag,
        currentCorrelationEndDate(ctx.timezone),
      );
    },
    correlationComputeOutputSchema,
    { keyVersion: "correlation.compute:v2" },
  ),

  computeV2: selectedChartCustomRangeQuery(
    "correlation.computeV2",
    CacheTTL.MEDIUM,
    correlationInputSchema("correlation.computeV2"),
    async ({ ctx, input, range }) => {
      assertDistinctMetrics(input.metricX, input.metricY);
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.computeV2(
        input.metricX,
        input.metricY,
        range.days,
        input.lag,
        currentCorrelationEndDate(ctx.timezone),
      );
    },
    correlationComputeV2OutputSchema,
    { keyVersion: "correlation.computeV2:v2" },
  ),

  observations: selectedChartCustomRangeQuery(
    "correlation.observations",
    CacheTTL.MEDIUM,
    correlationObservationsInputSchema,
    async ({ ctx, input, range }) => {
      assertDistinctMetrics(input.metricX, input.metricY);
      const repo = new CorrelationRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.listObservations(
        input.metricX,
        input.metricY,
        range.days,
        input.lag,
        currentCorrelationEndDate(ctx.timezone),
        {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          pageSize: input.pageSize,
        },
      );
    },
    correlationObservationPageSchema,
  ),
});
