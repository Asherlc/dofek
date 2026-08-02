export const BODY_TREND_WEIGHT_ALPHA = 0.1;
export const BODY_VARIATION_MIN_OBSERVATIONS = 8;
export const BODY_VARIATION_MAX_OBSERVATIONS = 30;

export interface BodyDecisionMeasurement {
  date: string;
  recordedAt: string;
  recordedAtLocal: string;
  weightKg: number;
  providerId: string;
  sourceName: string | null;
}

export interface BodyDecisionTrendPoint {
  date: string;
  smoothedWeight: number;
}

export interface BodyDecisionContext {
  latestMeasurement: BodyDecisionMeasurement | null;
  trendWeight: {
    smoothing: "ewma";
    alpha: number;
    gapHandling: "linear_interpolation";
    invalidWeightHandling: "exclude_non_positive";
    outlierHandling: "retain";
  };
  variation: {
    status: "available" | "insufficient_data";
    observations: number;
    minimumObservations: number;
    maximumObservations: number;
    method: "tukey_inner_fence";
    lowerResidualKg: number | null;
    upperResidualKg: number | null;
    outliersIncluded: true;
  };
}

function roundKg(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function quantile(sortedValues: readonly number[], probability: number): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function selectDailyMeasurements(
  measurements: readonly BodyDecisionMeasurement[],
): BodyDecisionMeasurement[] {
  const sorted = measurements
    .filter((measurement) => Number.isFinite(measurement.weightKg) && measurement.weightKg > 0)
    .toSorted((left, right) => {
      const dateOrder = left.date.localeCompare(right.date);
      return dateOrder === 0 ? left.recordedAt.localeCompare(right.recordedAt) : dateOrder;
    });

  const selected: BodyDecisionMeasurement[] = [];
  for (const measurement of sorted) {
    if (selected.at(-1)?.date !== measurement.date) {
      selected.push(measurement);
    }
  }
  return selected;
}

function buildVariation(
  measurements: readonly BodyDecisionMeasurement[],
  trendByDate: ReadonlyMap<string, BodyDecisionTrendPoint>,
): BodyDecisionContext["variation"] {
  const residuals = measurements.flatMap((measurement) => {
    const trendPoint = trendByDate.get(measurement.date);
    if (!trendPoint || !Number.isFinite(trendPoint.smoothedWeight)) return [];
    return [measurement.weightKg - trendPoint.smoothedWeight];
  });
  const recentResiduals = residuals.slice(-BODY_VARIATION_MAX_OBSERVATIONS);
  const base = {
    observations: recentResiduals.length,
    minimumObservations: BODY_VARIATION_MIN_OBSERVATIONS,
    maximumObservations: BODY_VARIATION_MAX_OBSERVATIONS,
    method: "tukey_inner_fence" as const,
    outliersIncluded: true as const,
  };

  if (recentResiduals.length < BODY_VARIATION_MIN_OBSERVATIONS) {
    return {
      ...base,
      status: "insufficient_data",
      lowerResidualKg: null,
      upperResidualKg: null,
    };
  }

  const sortedResiduals = [...recentResiduals].sort((left, right) => left - right);
  const lowerQuartile = quantile(sortedResiduals, 0.25);
  const upperQuartile = quantile(sortedResiduals, 0.75);
  const interquartileRange = upperQuartile - lowerQuartile;

  return {
    ...base,
    status: "available",
    lowerResidualKg: roundKg(lowerQuartile - 1.5 * interquartileRange),
    upperResidualKg: roundKg(upperQuartile + 1.5 * interquartileRange),
  };
}

export function buildBodyDecisionContext(
  measurements: readonly BodyDecisionMeasurement[],
  trendPoints: readonly BodyDecisionTrendPoint[],
): BodyDecisionContext {
  const selectedMeasurements = selectDailyMeasurements(measurements);
  const trendByDate = new Map(trendPoints.map((point) => [point.date, point]));

  return {
    latestMeasurement: selectedMeasurements.at(-1) ?? null,
    trendWeight: {
      smoothing: "ewma",
      alpha: BODY_TREND_WEIGHT_ALPHA,
      gapHandling: "linear_interpolation",
      invalidWeightHandling: "exclude_non_positive",
      outlierHandling: "retain",
    },
    variation: buildVariation(selectedMeasurements, trendByDate),
  };
}
