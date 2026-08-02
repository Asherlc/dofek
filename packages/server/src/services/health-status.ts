import { formatHRV, formatSteps } from "@dofek/format/format";
import { mean, sampleStandardDeviation } from "simple-statistics";
import type { z } from "zod";
import type { BaselineRelativeMetric } from "../contracts/baseline-relative-metrics.ts";
import {
  type HealthStatusMetric,
  healthMetricIntentSchema,
  healthMetricKeySchema,
  healthStatusMetricSchema,
} from "../contracts/mobile-dashboard-contracts.ts";
import type { TrendsRow } from "../repositories/daily-metrics-repository.ts";

export { healthMetricIntentSchema, healthMetricKeySchema, healthStatusMetricSchema };

export type HealthMetricIntent = z.infer<typeof healthMetricIntentSchema>;
export type { HealthStatusMetric };

export const HEALTH_STATUS_CACHE_KEY_VERSION = "health-status-evidence-v3";

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

function formatHealthStatusValue(
  metric: HealthStatusMetric["metric"],
  value: number | null,
): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (metric === "hrv") return formatHRV(value);
  if (metric === "steps") return formatSteps(value);
  return null;
}

function healthStatusSummary(input: HealthStatusSummaryInput) {
  return {
    ...input,
    valueText: formatHealthStatusValue(input.metric, input.value),
    baselineText: formatHealthStatusValue(input.metric, input.baseline),
  };
}

function insufficientData(input: HealthStatusSummaryInput): HealthStatusMetric {
  return {
    ...healthStatusSummary(input),
    deviation: null,
    direction: "unknown",
    statusToken: "insufficient_data",
    statusColor: "muted",
    statusLabel: "Not enough data",
    evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
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

function movingAsIntendedRule(direction: "above" | "below"): string {
  return direction === "above"
    ? "Above your baseline, where higher values support this metric"
    : "Below your baseline, where lower values support this metric";
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
      ...healthStatusSummary(input),
      deviation,
      direction,
      statusToken: "moving_as_intended",
      statusColor: "positive",
      statusLabel: "Moving as intended",
      evaluationRule: movingAsIntendedRule(direction),
      explanation: movingAsIntendedExplanation(input, direction),
    };
  }

  const absoluteDeviation = Math.abs(deviation);
  if (absoluteDeviation < 1) {
    return {
      ...healthStatusSummary(input),
      deviation,
      direction,
      statusToken: "near_baseline",
      statusColor: "positive",
      statusLabel: "Near baseline",
      evaluationRule: "Within your usual range: less than 1 standard deviation from baseline",
      explanation: `${input.label} is close to your usual range.`,
    };
  }

  if (direction === "aligned") {
    return {
      ...healthStatusSummary(input),
      deviation,
      direction,
      statusToken: "near_baseline",
      statusColor: "positive",
      statusLabel: "Near baseline",
      evaluationRule: "Within your usual range: less than 1 standard deviation from baseline",
      explanation: `${input.label} is close to your usual range.`,
    };
  }

  const farFromBaseline = absoluteDeviation >= 2;
  return {
    ...healthStatusSummary(input),
    deviation,
    direction,
    statusToken: farFromBaseline ? "far_from_baseline" : "notable_deviation",
    statusColor: farFromBaseline ? "danger" : "warning",
    statusLabel: `${farFromBaseline ? "Far" : "Notably"} ${direction} baseline`,
    evaluationRule: farFromBaseline
      ? "Well outside your usual range: at least 2 standard deviations from baseline"
      : "Outside your usual range: 1 to less than 2 standard deviations from baseline",
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

const recoveryMetricIntents: Record<BaselineRelativeMetric["metric"], HealthMetricIntent> = {
  hrv: "higher",
  resting_heart_rate: "lower",
  respiratory_rate: "lower",
  sleep_efficiency: "higher",
};

export function buildHealthStatusFromBaselineMetric(
  metric: BaselineRelativeMetric,
): HealthStatusMetric {
  return buildHealthStatusFromSummary({
    metric: metric.metric,
    label: metric.label,
    value: metric.value,
    baseline: metric.baseline.mean,
    sampleDeviation: metric.baseline.standardDeviation,
    intent: recoveryMetricIntents[metric.metric],
  });
}

export function buildDailyMetricHealthStatuses(
  trends: TrendsRow,
  baselineRelative: BaselineRelativeMetric[],
): HealthStatusMetric[] {
  return [
    ...baselineRelative.map(buildHealthStatusFromBaselineMetric),
    buildHealthStatusFromSummary({
      metric: "spo2",
      label: "Blood Oxygen Saturation (SpO2)",
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
