import type { ActivityModality } from "@dofek/training/activity-types";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import type { MetricStreamSourceRow } from "../db/metric-stream-writer.ts";
import type { JsonValue } from "../metric-stream/events.ts";
import type { ParsedFitRecord } from "./parser.ts";

function toJsonCompatible(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return value;
    case "object":
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (Array.isArray(value)) {
        return value.map(toJsonCompatible);
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, toJsonCompatible(entryValue)]),
      );
    default:
      return null;
  }
}

/**
 * Convert parsed FIT records into metric stream source rows.
 * Used by any provider that downloads FIT files (Wahoo, Coros, Suunto, etc.).
 */
export function fitRecordsToSensorSamples(
  records: ParsedFitRecord[],
  providerId: string,
  activityId: string,
  modality?: ActivityModality | null,
): MetricStreamSourceRow[] {
  const indoor = isIndoorCyclingModality(modality ?? null);
  return records.map((record) => ({
    providerId,
    activityId,
    recordedAt: record.recordedAt,
    heartRate: record.heartRate,
    power: record.power,
    cadence: record.cadence,
    speed: indoor ? undefined : record.speed,
    lat: record.lat,
    lng: record.lng,
    altitude: record.altitude,
    temperature: record.temperature,
    grade: record.grade,
    verticalSpeed: record.verticalSpeed,
    gpsAccuracy: record.gpsAccuracy,
    accumulatedPower: record.accumulatedPower,
    leftRightBalance: record.leftRightBalance,
    verticalOscillation: record.verticalOscillation,
    stanceTime: record.stanceTime,
    stanceTimePercent: record.stanceTimePercent,
    stepLength: record.stepLength,
    verticalRatio: record.verticalRatio,
    stanceTimeBalance: record.stanceTimeBalance,
    leftTorqueEffectiveness: record.leftTorqueEffectiveness,
    rightTorqueEffectiveness: record.rightTorqueEffectiveness,
    leftPedalSmoothness: record.leftPedalSmoothness,
    rightPedalSmoothness: record.rightPedalSmoothness,
    combinedPedalSmoothness: record.combinedPedalSmoothness,
    raw: toJsonCompatible(record.raw),
  }));
}
