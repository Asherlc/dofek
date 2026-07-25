import { mean, sampleStandardDeviation } from "simple-statistics";
import { z } from "zod";
import type { TrendsRow } from "../repositories/daily-metrics-repository.ts";

export const healthMetricKeySchema = z.enum([
  "hrv",
  "resting_heart_rate",
  "spo2",
  "steps",
  "skin_temperature",
  "trend_weight",
  "body_fat_percentage",
]);

export const healthMetricIntentSchema = z.enum(["higher", "lower", "maintain", "neutral"]);

export const healthStatusMetricSchema = z.object({
  metric: healthMetricKeySchema,
  label: z.string(),
  value: z.number().nullable(),
  baseline: z.number().nullable(),
  sampleDeviation: z.number().nullable(),
  deviation: z.number().nullable(),
  direction: z.enum(["above", "below", "aligned", "unknown"]),
  intent: healthMetricIntentSchema,
  statusToken: z.enum([
    "insufficient_data",
    "near_baseline",
    "moving_as_intended",
    "notable_deviation",
    "far_from_baseline",
  ]),
  statusColor: z.enum(["positive", "warning", "danger", "muted"]),
  statusLabel: z.string(),
  explanation: z.string(),
});

export type HealthMetricIntent = z.infer<typeof healthMetricIntentSchema>;
export type HealthStatusMetric = z.infer<typeof healthStatusMetricSchema>;

interface HealthStatusSummaryInput {
  metric: HealthStatusMetric["metric"];
  label: string;
  value: number | null;
  baseline: number | null;
  sampleDeviation: number | null;
  intent: HealthMetricIntent;
}

interface HealthStatusValuesInput {
  metric: HealthStatusMetric["metric"];
  label: string;
  values: readonly number[];
  intent: HealthMetricIntent;
}

interface WeightGoalIntentInput {
  goalWeightKg: number | null;
  currentWeightKg: number | null;
  baselineKg: number | null;
}

function insufficientData(input: HealthStatusSummaryInput): HealthStatusMetric {
  return {
    ...input,
    deviation: null,
    direction: "unknown",
    statusToken: "insufficient_data",
    statusColor: "muted",
    statusLabel: "Not enough data",
    explanation: "Not enough varied data yet to compare this value with your usual range.",
  };
}

function directionFromDeviation(deviation: number): "above" | "below" | "aligned" {
  if (deviation > 0) return "above";
  if (deviation < 0) return "below";
  return "aligned";
}

function isMovingAsIntended(
  intent: HealthMetricIntent,
  direction: "above" | "below" | "aligned",
): direction is "above" | "below" {
  return (
    (intent === "higher" && direction === "above") || (intent === "lower" && direction === "below")
  );
}

function movingAsIntendedExplanation(
  input: HealthStatusSummaryInput,
  direction: "above" | "below",
): string {
  if (input.metric === "trend_weight") {
    return `${input.label} is ${direction} your baseline, in line with your weight goal.`;
  }
  return `${input.label} is ${direction} your baseline, in the supported direction for this metric.`;
}

function deviationExplanation(
  label: string,
  direction: "above" | "below",
  farFromBaseline: boolean,
): string {
  return farFromBaseline
    ? `${label} is well ${direction} your usual range compared with recent variation.`
    : `${label} is ${direction} your usual range enough to stand out from recent variation.`;
}

export function buildHealthStatusFromSummary(input: HealthStatusSummaryInput): HealthStatusMetric {
  if (
    input.value == null ||
    input.baseline == null ||
    input.sampleDeviation == null ||
    !Number.isFinite(input.value) ||
    !Number.isFinite(input.baseline) ||
    !Number.isFinite(input.sampleDeviation) ||
    input.sampleDeviation <= 0
  ) {
    return insufficientData(input);
  }

  const deviation = (input.value - input.baseline) / input.sampleDeviation;
  const direction = directionFromDeviation(deviation);

  if (isMovingAsIntended(input.intent, direction)) {
    return {
      ...input,
      deviation,
      direction,
      statusToken: "moving_as_intended",
      statusColor: "positive",
      statusLabel: "Moving as intended",
      explanation: movingAsIntendedExplanation(input, direction),
    };
  }

  const absoluteDeviation = Math.abs(deviation);
  if (absoluteDeviation < 1) {
    return {
      ...input,
      deviation,
      direction,
      statusToken: "near_baseline",
      statusColor: "positive",
      statusLabel: "Near baseline",
      explanation: `${input.label} is close to your usual range.`,
    };
  }

  if (direction === "aligned") {
    return {
      ...input,
      deviation,
      direction,
      statusToken: "near_baseline",
      statusColor: "positive",
      statusLabel: "Near baseline",
      explanation: `${input.label} is close to your usual range.`,
    };
  }

  const farFromBaseline = absoluteDeviation >= 2;
  return {
    ...input,
    deviation,
    direction,
    statusToken: farFromBaseline ? "far_from_baseline" : "notable_deviation",
    statusColor: farFromBaseline ? "danger" : "warning",
    statusLabel: `${farFromBaseline ? "Far" : "Notably"} ${direction} baseline`,
    explanation: deviationExplanation(input.label, direction, farFromBaseline),
  };
}

export function buildHealthStatusFromValues(input: HealthStatusValuesInput): HealthStatusMetric {
  const values = input.values.filter(Number.isFinite);
  const value = values.at(-1) ?? null;
  const baseline = values.length > 0 ? mean(values) : null;
  const sampleDeviation = values.length > 1 ? sampleStandardDeviation(values) : null;

  return buildHealthStatusFromSummary({
    metric: input.metric,
    label: input.label,
    value,
    baseline,
    sampleDeviation,
    intent: input.intent,
  });
}

export function resolveWeightGoalIntent({
  goalWeightKg,
  currentWeightKg,
  baselineKg,
}: WeightGoalIntentInput): HealthMetricIntent {
  if (goalWeightKg == null || !Number.isFinite(goalWeightKg)) return "neutral";

  const references = [currentWeightKg, baselineKg].filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (references.length === 0) return "neutral";

  if (goalWeightKg < Math.min(...references)) return "lower";
  if (goalWeightKg > Math.max(...references)) return "higher";
  return "maintain";
}

export function buildWeightHealthStatus(
  values: readonly number[],
  goalWeightKg: number | null,
): HealthStatusMetric {
  const finiteValues = values.filter(Number.isFinite);
  const currentWeightKg = finiteValues.at(-1) ?? null;
  const baselineKg = finiteValues.length > 0 ? mean(finiteValues) : null;

  return buildHealthStatusFromSummary({
    metric: "trend_weight",
    label: "Trend Weight",
    value: currentWeightKg,
    baseline: baselineKg,
    sampleDeviation: finiteValues.length > 1 ? sampleStandardDeviation(finiteValues) : null,
    intent: resolveWeightGoalIntent({ goalWeightKg, currentWeightKg, baselineKg }),
  });
}

export function buildDailyMetricHealthStatuses(trends: TrendsRow): HealthStatusMetric[] {
  return [
    buildHealthStatusFromSummary({
      metric: "hrv",
      label: "Heart Rate Variability (HRV)",
      value: trends.latest_hrv,
      baseline: trends.avg_hrv,
      sampleDeviation: trends.stddev_hrv,
      intent: "higher",
    }),
    buildHealthStatusFromSummary({
      metric: "resting_heart_rate",
      label: "Resting Heart Rate",
      value: trends.latest_resting_hr,
      baseline: trends.avg_resting_hr,
      sampleDeviation: trends.stddev_resting_hr,
      intent: "lower",
    }),
    buildHealthStatusFromSummary({
      metric: "spo2",
      label: "SpO2",
      value: trends.latest_spo2,
      baseline: trends.avg_spo2,
      sampleDeviation: trends.stddev_spo2,
      intent: "neutral",
    }),
    buildHealthStatusFromSummary({
      metric: "steps",
      label: "Steps",
      value: trends.latest_steps,
      baseline: trends.avg_steps,
      sampleDeviation: trends.stddev_steps,
      intent: "neutral",
    }),
    buildHealthStatusFromSummary({
      metric: "skin_temperature",
      label: "Skin Temperature",
      value: trends.latest_skin_temp,
      baseline: trends.avg_skin_temp,
      sampleDeviation: trends.stddev_skin_temp,
      intent: "neutral",
    }),
  ];
}
