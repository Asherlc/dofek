import { isIndoorCycling } from "@dofek/training/endurance-types";
import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  WAHOO_WORKOUT_TYPE_MAP,
} from "@dofek/training/training";
import type { SensorSampleSourceRow } from "../../db/sensor-sample-writer.ts";
import type { ParsedFitRecord } from "../../fit/parser.ts";
import type { WahooWorkout, WahooWorkoutListResponse } from "./client.ts";

// ============================================================
// Activity type mapping
// ============================================================

const mapWahooWorkoutType = createActivityTypeMapper(WAHOO_WORKOUT_TYPE_MAP);

function mapWorkoutType(typeId: number): CanonicalActivityType {
  return mapWahooWorkoutType(typeId);
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedCardioActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name?: string;
  startedAt: Date;
  endedAt?: Date;
  fitFileUrl?: string;
}

export function parseWorkoutSummary(workout: WahooWorkout): ParsedCardioActivity {
  const summary = workout.workout_summary;

  return {
    externalId: String(workout.id),
    activityType: mapWorkoutType(workout.workout_type_id),
    name: workout.name,
    startedAt: new Date(workout.starts),
    endedAt: summary?.duration_total_accum
      ? new Date(new Date(workout.starts).getTime() + summary.duration_total_accum * 1000)
      : undefined,
    fitFileUrl: summary?.file?.url,
  };
}

export interface ParsedWorkoutList {
  workouts: ParsedCardioActivity[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

export function parseWorkoutList(response: WahooWorkoutListResponse): ParsedWorkoutList {
  return {
    workouts: response.workouts.map(parseWorkoutSummary),
    total: response.total,
    page: response.page,
    perPage: response.per_page,
    hasMore: response.page * response.per_page < response.total,
  };
}

// ============================================================
// FIT record → metric_stream mapping
// ============================================================

export function fitRecordsToMetricStream(
  records: ParsedFitRecord[],
  providerId: string,
  activityId: string,
  activityType?: string,
): SensorSampleSourceRow[] {
  const indoor = activityType ? isIndoorCycling(activityType) : false;
  return records.map((r) => ({
    providerId,
    activityId,
    recordedAt: r.recordedAt,
    heartRate: r.heartRate,
    power: r.power,
    cadence: r.cadence,
    speed: indoor ? undefined : r.speed,
    lat: r.lat,
    lng: r.lng,
    altitude: r.altitude,
    temperature: r.temperature,
    grade: r.grade,
    verticalSpeed: r.verticalSpeed,
    gpsAccuracy: r.gpsAccuracy,
    accumulatedPower: r.accumulatedPower,
    leftRightBalance: r.leftRightBalance,
    verticalOscillation: r.verticalOscillation,
    stanceTime: r.stanceTime,
    stanceTimePercent: r.stanceTimePercent,
    stepLength: r.stepLength,
    verticalRatio: r.verticalRatio,
    stanceTimeBalance: r.stanceTimeBalance,
    leftTorqueEffectiveness: r.leftTorqueEffectiveness,
    rightTorqueEffectiveness: r.rightTorqueEffectiveness,
    leftPedalSmoothness: r.leftPedalSmoothness,
    rightPedalSmoothness: r.rightPedalSmoothness,
    combinedPedalSmoothness: r.combinedPedalSmoothness,
    raw: r.raw,
  }));
}
