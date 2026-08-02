export const BODY_TREND_WEIGHT_DECISION_COPY =
  "Trend Weight moves 10% toward each selected daily scale reading. Missing days are linearly interpolated; non-positive values are excluded and outliers remain included.";

export const BODY_SOURCE_GUIDANCE =
  "For comparable readings, use the same scale at a consistent time of day.";

export const BODY_DECISION_CONTEXT_UNAVAILABLE =
  "Measurement decision context is temporarily unavailable. Refresh to try again.";

export interface BodyDecisionContextView {
  latestMeasurement: {
    recordedAtLocal: string;
    weightKg: number;
    providerId: string;
    sourceName: string | null;
  } | null;
  variation: {
    status: "available" | "insufficient_data";
    observations: number;
    minimumObservations: number;
    maximumObservations: number;
    lowerResidualKg: number | null;
    upperResidualKg: number | null;
  };
}

interface BodyDecisionLatestMeasurement {
  recordedAtLocal: string;
  weightKg: number;
  providerId: string;
  sourceName: string | null;
}

interface BodyDecisionVariation {
  status: "available" | "insufficient_data";
  observations: number;
  minimumObservations: number;
  maximumObservations: number;
  lowerResidualKg: number | null;
  upperResidualKg: number | null;
}

export function formatBodyDecisionProvenance(
  measurement: BodyDecisionLatestMeasurement | null,
  options: {
    formatWeight: (weightKg: number) => string;
    providerLabel: (providerId: string) => string;
  },
): string | null {
  if (measurement == null) return null;

  const source = measurement.sourceName != null ? `Source: ${measurement.sourceName}` : null;
  return [
    `Latest scale reading: ${options.formatWeight(measurement.weightKg)}`,
    `Provider: ${options.providerLabel(measurement.providerId)}`,
    source,
    `Recorded: ${measurement.recordedAtLocal}`,
  ]
    .filter((part): part is string => part != null)
    .join(" · ");
}

export function formatSignedBodyResidual(
  residualKg: number,
  formatWeight: (absoluteWeightKg: number) => string,
): string {
  const magnitude = formatWeight(Math.abs(residualKg));
  if (residualKg > 0) return `+${magnitude}`;
  if (residualKg < 0) return `-${magnitude}`;
  return magnitude;
}

export function formatBodyDecisionVariation(
  variation: BodyDecisionVariation,
  formatResidual: (residualKg: number) => string,
): string {
  if (
    variation.status !== "available" ||
    variation.lowerResidualKg == null ||
    variation.upperResidualKg == null
  ) {
    return `Personalized typical measurement variation is unavailable until at least ${variation.minimumObservations} actual scale readings are available.`;
  }

  return `Personalized typical measurement variation is ${formatResidual(variation.lowerResidualKg)} to ${formatResidual(variation.upperResidualKg)} around Trend Weight, based on ${variation.observations} of the latest ${variation.maximumObservations} actual scale readings. This is informational, not a clinical threshold; outliers remain included.`;
}
