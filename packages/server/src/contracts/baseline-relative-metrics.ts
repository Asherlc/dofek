import { z } from "zod";

export const baselineRelativeMetricKeySchema = z.enum([
  "hrv",
  "resting_heart_rate",
  "respiratory_rate",
  "sleep_efficiency",
]);

export const baselineComparisonDirectionSchema = z.enum([
  "increasing",
  "decreasing",
  "stable",
  "unknown",
]);

export const baselineRelativeMetricSchema = z.object({
  metric: baselineRelativeMetricKeySchema,
  label: z.string(),
  value: z.number().nullable(),
  baseline: z.object({
    windowDays: z.literal(30),
    mean: z.number().nullable(),
    standardDeviation: z.number().nullable(),
    zScore: z.number().nullable(),
    sampleCount: z.number().int().min(0).max(30),
    coverage: z.number().min(0).max(1),
  }),
  comparison: z.object({
    recentDays: z.literal(7),
    baselineDays: z.literal(28),
    recentMean: z.number().nullable(),
    baselineMean: z.number().nullable(),
    delta: z.number().nullable(),
    direction: baselineComparisonDirectionSchema,
  }),
});

export type BaselineRelativeMetric = z.infer<typeof baselineRelativeMetricSchema>;

interface BaselineRelativeMetricInput {
  metric: BaselineRelativeMetric["metric"];
  label: string;
  value: number | null;
  baselineMean: number | null;
  baselineStandardDeviation: number | null;
  zScore: number | null;
  baselineSampleCount: number;
  baselineCoverage: number;
  recentMean: number | null;
  comparisonMean: number | null;
}

function comparisonDirection(
  delta: number | null,
): BaselineRelativeMetric["comparison"]["direction"] {
  if (delta == null) return "unknown";
  if (delta > 0) return "increasing";
  if (delta < 0) return "decreasing";
  return "stable";
}

export function buildBaselineRelativeMetric(
  input: BaselineRelativeMetricInput,
): BaselineRelativeMetric {
  const delta =
    input.recentMean != null && input.comparisonMean != null
      ? input.recentMean - input.comparisonMean
      : null;

  return baselineRelativeMetricSchema.parse({
    metric: input.metric,
    label: input.label,
    value: input.value,
    baseline: {
      windowDays: 30,
      mean: input.baselineMean,
      standardDeviation: input.baselineStandardDeviation,
      zScore: input.zScore,
      sampleCount: input.baselineSampleCount,
      coverage: input.baselineCoverage,
    },
    comparison: {
      recentDays: 7,
      baselineDays: 28,
      recentMean: input.recentMean,
      baselineMean: input.comparisonMean,
      delta,
      direction: comparisonDirection(delta),
    },
  });
}
