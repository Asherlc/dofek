import {
  APPLE_HEALTH_WORKOUT_TYPE_MAP,
  type CanonicalActivityType,
} from "@dofek/training/training";
import { z } from "zod";
import { parseHealthDate } from "./dates.ts";
import type { RouteLocation } from "./records.ts";

export interface HangTenActivitySegment {
  stepID: string;
  stepNumber: number;
  kind: "work" | "rest";
  holdIDs: string[];
  holdType?: string;
  sizeMillimeters?: number;
  durationSeconds?: number;
}

export interface HangTenWorkoutMetadata {
  sessionId?: string;
  planName: string;
  boardId?: string;
  boardName?: string;
  rawActivitySegments?: string;
  activitySegments?: HangTenActivitySegment[];
  activitySegmentsError?: string;
}

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
  metadata?: Record<string, string>;
  hangTen?: HangTenWorkoutMetadata;
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

export function parseWorkout(
  attrs: Record<string, string>,
  metadata: Record<string, string> = {},
): HealthWorkout {
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

  return applyWorkoutMetadata(
    {
      activityType,
      sourceName: attrs.sourceName ?? null,
      durationSeconds,
      distanceMeters,
      calories,
      startDate: parseHealthDate(attrs.startDate ?? ""),
      endDate: parseHealthDate(attrs.endDate ?? ""),
    },
    metadata,
  );
}

function trimmedMetadataValue(metadata: Record<string, string>, key: string): string | undefined {
  const value = metadata[key]?.trim();
  return value ? value : undefined;
}

const hangTenActivityMetadataSchema = z.object({
  version: z.number().optional(),
  segments: z.array(
    z.object({
      stepID: z.string(),
      stepNumber: z.number(),
      kind: z.enum(["work", "rest"]),
      holdIDs: z.array(z.string()),
      holdType: z.string().optional(),
      sizeMillimeters: z.number().optional(),
      durationSeconds: z.number().optional(),
    }),
  ),
});

function parseHangTenActivitySegments(raw: string): {
  segments?: HangTenActivitySegment[];
  error?: string;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = hangTenActivityMetadataSchema.safeParse(parsed);
    if (!result.success) {
      return {
        error: "Invalid Hang Ten activity segments JSON: segment metadata has invalid fields",
      };
    }
    return { segments: result.data.segments };
  } catch {
    return { error: "Invalid Hang Ten activity segments JSON: could not parse JSON" };
  }
}

function hangTenWorkoutOverrides(
  activityType: CanonicalActivityType,
  metadata: Record<string, string>,
): Partial<HealthWorkout> {
  if (
    activityType !== "functional_strength" ||
    metadata.HKMetadataKeyWorkoutBrandName !== "Hang Ten"
  ) {
    return {};
  }

  const planName = trimmedMetadataValue(metadata, "HangTen.PlanName");
  if (!planName) return {};

  const rawActivitySegments = metadata["HangTen.ActivitySegments"];
  const parsedActivitySegments = rawActivitySegments
    ? parseHangTenActivitySegments(rawActivitySegments)
    : {};

  return {
    activityType: "hangboard",
    sourceName: "Hang Ten",
    hangTen: {
      sessionId: trimmedMetadataValue(metadata, "HangTen.SessionID"),
      planName,
      boardId: trimmedMetadataValue(metadata, "HangTen.BoardID"),
      boardName: trimmedMetadataValue(metadata, "HangTen.BoardName"),
      rawActivitySegments,
      activitySegments: parsedActivitySegments.segments,
      activitySegmentsError: parsedActivitySegments.error,
    },
  };
}

export function applyWorkoutMetadata(
  workout: HealthWorkout,
  metadata: Record<string, string>,
): HealthWorkout {
  return {
    ...workout,
    metadata,
    ...hangTenWorkoutOverrides(workout.activityType, metadata),
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
