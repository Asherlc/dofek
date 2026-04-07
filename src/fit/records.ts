import { isIndoorCycling } from "@dofek/training/endurance-types";
import type { SensorSampleSourceRow } from "../db/sensor-sample-writer.ts";
import type { ParsedFitRecord } from "./parser.ts";

/**
 * Convert parsed FIT records into sensor sample source rows.
 * Used by any provider that downloads FIT files (Wahoo, Coros, Suunto, etc.).
 */
export function fitRecordsToSensorSamples(
  records: ParsedFitRecord[],
  providerId: string,
  activityId: string,
  activityType?: string,
): SensorSampleSourceRow[] {
  const indoor = activityType ? isIndoorCycling(activityType) : false;
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
    raw: record.raw,
  }));
}
