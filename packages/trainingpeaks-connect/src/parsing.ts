import { mapTrainingPeaksSport } from "./sports.ts";
import type {
  TrainingPeaksPmcEntry,
  TrainingPeaksWorkout,
} from "./types.ts";

// ============================================================
// Parsed output types
// ============================================================

export interface ParsedWorkout {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  completed: boolean;
  distanceMeters?: number;
  durationSeconds?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averagePower?: number;
  normalizedPower?: number;
  cadenceAverage?: number;
  elevationGain?: number;
  calories?: number;
  trainingStressScore?: number;
  intensityFactor?: number;
  feeling?: number;
  rpe?: number;
  raw: TrainingPeaksWorkout;
}

export interface ParsedPerformanceManagement {
  date: string;
  tss: number;
  fitness: number;
  fatigue: number;
  form: number;
}

// ============================================================
// Parsing functions
// ============================================================

/**
 * Convert TrainingPeaks decimal hours to seconds.
 * TrainingPeaks stores totalTime as decimal hours (e.g., 1.25 = 1h15m).
 */
export function decimalHoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

/** Parse a TrainingPeaks workout into our normalized format. */
export function parseTrainingPeaksWorkout(raw: TrainingPeaksWorkout): ParsedWorkout {
  // Use startTime if available, fall back to workoutDay
  const startTimeStr = raw.startTime ?? raw.startTimePlanned ?? raw.workoutDay;
  const startedAt = new Date(startTimeStr);

  // Calculate end time from actual or planned duration
  const totalTimeHours = raw.totalTime ?? raw.totalTimePlanned ?? 0;
  const durationSeconds = decimalHoursToSeconds(totalTimeHours);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    externalId: String(raw.workoutId),
    activityType: mapTrainingPeaksSport(raw.workoutTypeFamilyId),
    name: raw.title,
    startedAt,
    endedAt,
    completed: raw.completed,
    distanceMeters: raw.distance,
    durationSeconds: durationSeconds > 0 ? durationSeconds : undefined,
    averageHeartRate: raw.heartRateAverage,
    maxHeartRate: raw.heartRateMaximum,
    averagePower: raw.powerAverage,
    normalizedPower: raw.normalizedPowerActual,
    cadenceAverage: raw.cadenceAverage,
    elevationGain: raw.elevationGain,
    calories: raw.calories,
    trainingStressScore: raw.tssActual ?? raw.tssPlanned,
    intensityFactor: raw.if ?? raw.ifPlanned,
    feeling: raw.feeling,
    rpe: raw.rpe,
    raw,
  };
}

/** Parse a PMC data point into our normalized format. */
export function parseTrainingPeaksPmc(entry: TrainingPeaksPmcEntry): ParsedPerformanceManagement {
  return {
    date: entry.workoutDay,
    tss: entry.tssActual,
    fitness: entry.ctl,
    fatigue: entry.atl,
    form: entry.tsb,
  };
}
