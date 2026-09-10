export interface DirectWeightObservation {
  date: string;
  recordedAt: string;
  valueKg: number;
  observationType: "body_weight" | "body_fat" | "lean_mass";
  measurementKind: "direct" | "estimated" | "unknown";
  provider: string;
  sourceRecordId: string | null;
}

export interface WeightEvidenceSource {
  date: string;
  recorded_at: string;
  value_kg: number;
  provider: string;
  source_record_id: string | null;
  measurement_kind: "direct";
}

export interface WeightEvidence {
  value_kg: number;
  kind: "measured" | "interpolated" | "nearest";
  method: "same_day" | "linear_interpolation" | "nearest_within_30_days";
  quality: "high" | "medium" | "low";
  distance_days: number;
  sources: WeightEvidenceSource[];
}

export interface UnavailableWeightEvidence {
  value_kg: null;
  reason: string;
}

const DAY_MILLISECONDS = 86_400_000;

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / DAY_MILLISECONDS;
}

function source(observation: DirectWeightObservation): WeightEvidenceSource {
  return {
    date: observation.date,
    recorded_at: observation.recordedAt,
    value_kg: observation.valueKg,
    provider: observation.provider,
    source_record_id: observation.sourceRecordId,
    measurement_kind: "direct",
  };
}

export function selectNearbyWeight(
  effortDate: string,
  measurements: readonly DirectWeightObservation[],
): WeightEvidence | UnavailableWeightEvidence {
  const valid = measurements
    .filter(
      (measurement) =>
        measurement.observationType === "body_weight" &&
        measurement.measurementKind === "direct" &&
        Number.isFinite(measurement.valueKg) &&
        measurement.valueKg > 0 &&
        Number.isFinite(dayNumber(measurement.date)),
    )
    .sort(
      (left, right) =>
        dayNumber(left.date) - dayNumber(right.date) ||
        left.recordedAt.localeCompare(right.recordedAt),
    );
  if (valid.length === 0) {
    return {
      value_kg: null,
      reason: "No valid positive directly measured body weight is available",
    };
  }

  const effortDay = dayNumber(effortDate);
  const sameDay = valid.filter((measurement) => dayNumber(measurement.date) === effortDay).at(-1);
  if (sameDay) {
    return {
      value_kg: sameDay.valueKg,
      kind: "measured",
      method: "same_day",
      quality: "high",
      distance_days: 0,
      sources: [source(sameDay)],
    };
  }

  const before = valid.filter((measurement) => dayNumber(measurement.date) < effortDay).at(-1);
  const after = valid.find((measurement) => dayNumber(measurement.date) > effortDay);
  const beforeDistance = before ? effortDay - dayNumber(before.date) : Number.POSITIVE_INFINITY;
  const afterDistance = after ? dayNumber(after.date) - effortDay : Number.POSITIVE_INFINITY;
  if (before && after && beforeDistance <= 14 && afterDistance <= 14) {
    const spanDays = dayNumber(after.date) - dayNumber(before.date);
    const fraction = beforeDistance / spanDays;
    return {
      value_kg: before.valueKg + (after.valueKg - before.valueKg) * fraction,
      kind: "interpolated",
      method: "linear_interpolation",
      quality: "medium",
      distance_days: Math.max(beforeDistance, afterDistance),
      sources: [source(before), source(after)],
    };
  }

  const nearest = valid
    .map((measurement) => ({
      distance: Math.abs(dayNumber(measurement.date) - effortDay),
      measurement,
    }))
    .filter(({ distance }) => distance <= 30)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        dayNumber(left.measurement.date) - dayNumber(right.measurement.date) ||
        right.measurement.recordedAt.localeCompare(left.measurement.recordedAt),
    )[0];
  if (!nearest) {
    return {
      value_kg: null,
      reason: "No directly measured body weight within 30 days of the effort",
    };
  }

  return {
    value_kg: nearest.measurement.valueKg,
    kind: "nearest",
    method: "nearest_within_30_days",
    quality: "low",
    distance_days: nearest.distance,
    sources: [source(nearest.measurement)],
  };
}
