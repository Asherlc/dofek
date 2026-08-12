import {
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import { APPLE_HEALTH_WORKOUT_TYPE_MAP } from "@dofek/training/training";
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

export type WorkoutMetadata = Record<string, string | number>;

export interface HealthWorkout {
  activityType: ProviderActivityType;
  sourceName: string | null;
  durationSeconds: number;
  distanceMeters?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  startDate: Date;
  endDate: Date;
  routeLocations?: RouteLocation[];
  metadata?: WorkoutMetadata;
  hangTen?: HangTenWorkoutMetadata;
}

export function workoutExternalId(workout: HealthWorkout): string {
  return workout.hangTen?.sessionId
    ? `ah:workout:${workout.hangTen.sessionId}`
    : `ah:workout:${workout.startDate.toISOString()}`;
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
  const activityType = resolveProviderActivityType(rawType, WORKOUT_TYPE_MAP[rawType] ?? "other");

  const durationSeconds = normalizeDuration(attrs.duration ?? "0", attrs.durationUnit ?? "min");

  let distanceMeters: number | undefined;
  if (attrs.totalDistance) {
    distanceMeters = normalizeDistance(attrs.totalDistance, attrs.totalDistanceUnit ?? "m");
  }

  return applyWorkoutMetadata(
    {
      activityType,
      sourceName: attrs.sourceName ?? null,
      durationSeconds,
      distanceMeters,
      startDate: parseHealthDate(attrs.startDate ?? ""),
      endDate: parseHealthDate(attrs.endDate ?? ""),
    },
    metadata,
  );
}

function trimmedMetadataValue(metadata: WorkoutMetadata, key: string): string | undefined {
  const rawValue = metadata[key];
  const value = typeof rawValue === "string" ? rawValue.trim() : undefined;
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
  activityType: ProviderActivityType,
  metadata: WorkoutMetadata,
): Partial<HealthWorkout> {
  if (
    activityType.canonicalType !== "strength" ||
    activityType.modality !== "functional" ||
    metadata.HKMetadataKeyWorkoutBrandName !== "Hang Ten"
  ) {
    return {};
  }

  const planName = trimmedMetadataValue(metadata, "HangTen.PlanName");
  if (!planName) return {};

  const activitySegmentsMetadata = metadata["HangTen.ActivitySegments"];
  const rawActivitySegments =
    typeof activitySegmentsMetadata === "string" ? activitySegmentsMetadata : undefined;
  const parsedActivitySegments =
    rawActivitySegments !== undefined ? parseHangTenActivitySegments(rawActivitySegments) : {};

  return {
    activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
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
  metadata: WorkoutMetadata,
): HealthWorkout {
  return {
    ...workout,
    metadata,
    ...hangTenWorkoutOverrides(workout.activityType, metadata),
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
    }
  }
}
