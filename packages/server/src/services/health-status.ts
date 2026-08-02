import { formatHRV, formatSteps } from "@dofek/format/format";
import { mean, sampleStandardDeviation } from "simple-statistics";
import type { z } from "zod";
import type { BaselineRelativeMetric } from "../contracts/baseline-relative-metrics.ts";
import type { BaselineProgress } from "../contracts/mobile-dashboard-contracts.ts";
import {
  type HealthMetricComparison,
  type HealthMetricProvenance,
  type HealthStatusMetric,
  healthMetricIntentSchema,
  healthMetricKeySchema,
  healthStatusMetricSchema,
} from "../contracts/mobile-dashboard-contracts.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type {
  HealthMetricEvidenceRow,
  TrendsRow,
} from "../repositories/daily-metrics-repository.ts";
import { type BaselineProcessingStatus, buildBaselineProgress } from "./baseline-progress.ts";

export { healthMetricIntentSchema, healthMetricKeySchema, healthStatusMetricSchema };

export type HealthMetricIntent = z.infer<typeof healthMetricIntentSchema>;
export type { HealthStatusMetric };

export type HealthMetricObservation = {
  date: string;
  value: number | null;
  sourceProviders: readonly string[];
};

export type HealthMetricEvidence = {
  provenance: HealthMetricProvenance;
  comparison: HealthMetricComparison;
};

function hasFiniteValue(
  observation: HealthMetricObservation,
): observation is HealthMetricObservation & { value: number } {
  return observation.value != null && Number.isFinite(observation.value);
}

export const HEALTH_STATUS_CACHE_KEY_VERSION = "health-status-evidence-v3";

interface HealthStatusSummaryInput {
  metric: HealthStatusMetric["metric"];
  label: string;
  value: number | null;
  baseline: number | null;
  sampleDeviation: number | null;
  intent: HealthMetricIntent;
  observedDays?: number;
  processingStatus?: BaselineProcessingStatus;
  provenance?: HealthMetricProvenance | null;
  comparison?: HealthMetricComparison | null;
}

interface HealthStatusValuesInput {
  metric: HealthStatusMetric["metric"];
  label: string;
  values: readonly number[];
  intent: HealthMetricIntent;
  observations?: readonly HealthMetricObservation[];
  windowDays?: number;
  processingStatus?: BaselineProcessingStatus;
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

function metricFields(input: HealthStatusSummaryInput) {
  return {
    metric: input.metric,
    label: input.label,
    value: input.value,
    valueText: formatHealthStatusValue(input.metric, input.value),
    baseline: input.baseline,
    baselineText: formatHealthStatusValue(input.metric, input.baseline),
    sampleDeviation: input.sampleDeviation,
    intent: input.intent,
    provenance: input.provenance ?? null,
    comparison: input.comparison ?? null,
  };
}

function comparisonDirection(delta: number | null): HealthMetricComparison["direction"] {
  if (delta == null) return "unknown";
  if (delta > 0) return "increasing";
  if (delta < 0) return "decreasing";
  return "stable";
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length > 0 ? mean(values) : null;
}

function roundComparisonValue(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(10));
}

export function buildHealthMetricEvidence(
  observations: readonly HealthMetricObservation[],
  windowDays: number,
): HealthMetricEvidence {
  const validObservations = [...observations]
    .filter(hasFiniteValue)
    .sort((first, second) => first.date.localeCompare(second.date));
  const latest = validObservations.at(-1);
  const latestDate = latest?.date ?? null;
  const recentValues = latestDate
    ? validObservations
        .filter((observation) => observation.date > dateWindowStartString(latestDate, 7))
        .map((observation) => observation.value)
    : [];
  const baselineValues = latestDate
    ? validObservations
        .filter(
          (observation) =>
            observation.date > dateWindowStartString(latestDate, 35) &&
            observation.date <= dateWindowStartString(latestDate, 7),
        )
        .map((observation) => observation.value)
    : [];
  const recentMean = meanOrNull(recentValues);
  const baselineMean = meanOrNull(baselineValues);
  const delta =
    recentMean != null && baselineMean != null
      ? roundComparisonValue(recentMean - baselineMean)
      : null;

  return {
    provenance: {
      latestDate,
      sourceProviders: latest
        ? [...new Set(latest.sourceProviders)].sort((first, second) => first.localeCompare(second))
        : [],
      observedDays: validObservations.length,
      windowDays,
    },
    comparison: {
      recentDays: 7,
      baselineDays: 28,
      recentMean,
      baselineMean,
      delta,
      direction: comparisonDirection(delta),
    },
  };
}

function evidenceFromRow(row: HealthMetricEvidenceRow, windowDays: number): HealthMetricEvidence {
  const delta = roundComparisonValue(
    row.recentMean != null && row.baselineMean != null ? row.recentMean - row.baselineMean : null,
  );
  return {
    provenance: {
      latestDate: row.latestDate,
      sourceProviders: row.sourceProviders,
      observedDays: row.observedDays,
      windowDays,
    },
    comparison: {
      recentDays: 7,
      baselineDays: 28,
      recentMean: row.recentMean,
      baselineMean: row.baselineMean,
      delta,
      direction: comparisonDirection(delta),
    },
  };
}

function evidenceForMetric(
  trends: TrendsRow,
  metric: keyof NonNullable<TrendsRow["metric_evidence"]>,
  windowDays: number,
): HealthMetricEvidence | null {
  const row = trends.metric_evidence?.[metric];
  return row ? evidenceFromRow(row, windowDays) : null;
}

function insufficientData(input: HealthStatusSummaryInput): HealthStatusMetric {
  const baselineProgress = buildBaselineProgress({
    label: input.label,
    value: input.value,
    observedDays: input.observedDays ?? 0,
    sampleDeviation: input.sampleDeviation,
    processingStatus: input.processingStatus ?? null,
  });

  return {
    ...metricFields(input),
    deviation: null,
    direction: "unknown",
    statusToken: "insufficient_data",
    statusColor: "muted",
    statusLabel: "Not enough data",
    evaluationRule: "Needs a current value, baseline, and measurable day-to-day variation",
    explanation: "Not enough varied data yet to compare this value with your usual range.",
    baselineProgress,
  };
}

function baselineProgressFor(input: HealthStatusSummaryInput): BaselineProgress {
  return buildBaselineProgress({
    label: input.label,
    value: input.value,
    observedDays: input.observedDays ?? 0,
    sampleDeviation: input.sampleDeviation,
    processingStatus: input.processingStatus ?? null,
  });
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
  const baselineProgress = baselineProgressFor(input);

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
      ...metricFields(input),
      baselineProgress,
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
      ...metricFields(input),
      baselineProgress,
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
      ...metricFields(input),
      baselineProgress,
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
    ...metricFields(input),
    baselineProgress,
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
  const evidence = input.observations
    ? buildHealthMetricEvidence(input.observations, input.windowDays ?? Math.max(values.length, 1))
    : null;

  return buildHealthStatusFromSummary({
    metric: input.metric,
    label: input.label,
    value,
    baseline,
    sampleDeviation,
    intent: input.intent,
    observedDays: values.length,
    processingStatus: input.processingStatus ?? null,
    provenance: evidence?.provenance ?? null,
    comparison: evidence?.comparison ?? null,
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
  processingStatus: BaselineProcessingStatus = null,
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
    observedDays: finiteValues.length,
    processingStatus,
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
  processingStatus: BaselineProcessingStatus = null,
  provenance: HealthMetricProvenance | null = null,
): HealthStatusMetric {
  return buildHealthStatusFromSummary({
    metric: metric.metric,
    label: metric.label,
    value: metric.value,
    baseline: metric.baseline.mean,
    sampleDeviation: metric.baseline.standardDeviation,
    intent: recoveryMetricIntents[metric.metric],
    observedDays: metric.baseline.sampleCount,
    processingStatus,
    provenance,
    comparison: metric.comparison,
  });
}

export function buildDailyMetricHealthStatuses(
  trends: TrendsRow,
  baselineRelative: BaselineRelativeMetric[],
  processingStatus: BaselineProcessingStatus = null,
  windowDays = 30,
): HealthStatusMetric[] {
  const hrvEvidence = evidenceForMetric(trends, "hrv", windowDays);
  const spo2Evidence = evidenceForMetric(trends, "spo2", windowDays);
  const stepsEvidence = evidenceForMetric(trends, "steps", windowDays);
  const skinTemperatureEvidence = evidenceForMetric(trends, "skin_temperature", windowDays);

  const baselineStatuses = baselineRelative.map((metric) =>
    buildHealthStatusFromBaselineMetric(
      metric,
      processingStatus,
      metric.metric === "hrv" ? (hrvEvidence?.provenance ?? null) : null,
    ),
  );
  const restingHeartRateStatus = baselineRelative.some(
    (metric) => metric.metric === "resting_heart_rate",
  )
    ? null
    : buildHealthStatusFromSummary({
        metric: "resting_heart_rate",
        label: "Resting Heart Rate",
        value: trends.latest_resting_hr,
        baseline: trends.avg_resting_hr,
        sampleDeviation: trends.stddev_resting_hr,
        intent: "lower",
        observedDays: trends.sample_count_resting_hr ?? 0,
        processingStatus,
      });

  return [
    ...baselineStatuses,
    ...(restingHeartRateStatus ? [restingHeartRateStatus] : []),
    buildHealthStatusFromSummary({
      metric: "spo2",
      label: "Blood Oxygen Saturation (SpO2)",
      value: trends.latest_spo2,
      baseline: trends.avg_spo2,
      sampleDeviation: trends.stddev_spo2,
      intent: "neutral",
      observedDays: trends.sample_count_spo2 ?? 0,
      processingStatus,
      provenance: spo2Evidence?.provenance ?? null,
      comparison: spo2Evidence?.comparison ?? null,
    }),
    buildHealthStatusFromSummary({
      metric: "steps",
      label: "Steps",
      value: trends.latest_steps,
      baseline: trends.avg_steps,
      sampleDeviation: trends.stddev_steps,
      intent: "neutral",
      observedDays: trends.sample_count_steps ?? 0,
      processingStatus,
      provenance: stepsEvidence?.provenance ?? null,
      comparison: stepsEvidence?.comparison ?? null,
    }),
    buildHealthStatusFromSummary({
      metric: "skin_temperature",
      label: "Skin Temperature",
      value: trends.latest_skin_temp,
      baseline: trends.avg_skin_temp,
      sampleDeviation: trends.stddev_skin_temp,
      intent: "neutral",
      observedDays: trends.sample_count_skin_temp ?? 0,
      processingStatus,
      provenance: skinTemperatureEvidence?.provenance ?? null,
      comparison: skinTemperatureEvidence?.comparison ?? null,
    }),
  ];
}

export function buildRestingHeartRateTrendLabel(input: {
  latest: number | null;
  average: number | null;
  baselineProgress: Pick<BaselineProgress, "blocker">;
}): string {
  if (input.baselineProgress.blocker !== null) return "Waiting for baseline";
  if (input.latest == null || input.average == null) return "Waiting for baseline";
  if (input.latest < input.average) return "below average";
  if (input.latest > input.average) return "above average";
  return "at average";
}
