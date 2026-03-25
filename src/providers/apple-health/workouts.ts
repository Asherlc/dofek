import {
  APPLE_HEALTH_WORKOUT_TYPE_MAP,
  type CanonicalActivityType,
} from "@dofek/training/training";
import { parseHealthDate } from "./dates.ts";
import type { RouteLocation } from "./records.ts";

export interface HealthWorkout {
  activityType: CanonicalActivityType;
  sourceName: string | null;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  startDate: Date;
  endDate: Date;
  routeLocations?: RouteLocation[];
}

// Re-export as WORKOUT_TYPE_MAP for backward compatibility
export const WORKOUT_TYPE_MAP = APPLE_HEALTH_WORKOUT_TYPE_MAP;

export function normalizeDuration(value: string, unit: string): number {
  const numericValue = parseFloat(value);
  switch (unit) {
    case "min":
      return numericValue * 60;
    case "hr":
      return numericValue * 3600;
    default:
      return numericValue; // assume seconds
  }
}

export function normalizeDistance(value: string, unit: string): number {
  const numericValue = parseFloat(value);
  switch (unit) {
    case "km":
      return numericValue * 1000;
    case "mi":
      return numericValue * 1609.344;
    default:
      return numericValue; // assume meters
  }
}

export function parseWorkout(attrs: Record<string, string>): HealthWorkout {
  const rawType = attrs.workoutActivityType ?? "HKWorkoutActivityTypeOther";
  const activityType: CanonicalActivityType = WORKOUT_TYPE_MAP[rawType] ?? "other";

  const durationSeconds = normalizeDuration(attrs.duration ?? "0", attrs.durationUnit ?? "min");

  let distanceMeters: number | undefined;
  if (attrs.totalDistance) {
    distanceMeters = normalizeDistance(attrs.totalDistance, attrs.totalDistanceUnit ?? "m");
  }

  let calories: number | undefined;
  if (attrs.totalEnergyBurned) {
    const raw = parseFloat(attrs.totalEnergyBurned);
    // Apple Health always reports in kcal
    calories = Math.round(raw);
  }

  return {
    activityType,
    sourceName: attrs.sourceName ?? null,
    durationSeconds,
    distanceMeters,
    calories,
    startDate: parseHealthDate(attrs.startDate ?? ""),
    endDate: parseHealthDate(attrs.endDate ?? ""),
  };
}

export interface ActivitySummary {
  date: string; // YYYY-MM-DD
  activeEnergyBurned?: number;
  appleExerciseMinutes?: number;
  appleStandHours?: number;
}

export function parseActivitySummary(attrs: Record<string, string>): ActivitySummary | null {
  const date = attrs.dateComponents;
  if (!date) return null;

  return {
    date,
    activeEnergyBurned: attrs.activeEnergyBurned ? parseFloat(attrs.activeEnergyBurned) : undefined,
    appleExerciseMinutes: attrs.appleExerciseTime ? parseFloat(attrs.appleExerciseTime) : undefined,
    appleStandHours: attrs.appleStandHours ? parseFloat(attrs.appleStandHours) : undefined,
  };
}

export interface WorkoutStatistics {
  type: string;
  sum?: number;
  average?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
}

export function parseWorkoutStatistics(attrs: Record<string, string>): WorkoutStatistics | null {
  if (!attrs.type) return null;
  return {
    type: attrs.type,
    sum: attrs.sum ? parseFloat(attrs.sum) : undefined,
    average: attrs.average ? parseFloat(attrs.average) : undefined,
    minimum: attrs.minimum ? parseFloat(attrs.minimum) : undefined,
    maximum: attrs.maximum ? parseFloat(attrs.maximum) : undefined,
    unit: attrs.unit,
  };
}

export function enrichWorkoutFromStats(workout: HealthWorkout, stats: WorkoutStatistics[]): void {
  for (const s of stats) {
    switch (s.type) {
      case "HKQuantityTypeIdentifierHeartRate":
        if (s.average !== undefined) workout.avgHeartRate = Math.round(s.average);
        if (s.maximum !== undefined) workout.maxHeartRate = Math.round(s.maximum);
        break;
      case "HKQuantityTypeIdentifierActiveEnergyBurned":
        if (s.sum !== undefined && workout.calories === undefined) {
          workout.calories = Math.round(s.sum);
        }
        break;
    }
  }
}
