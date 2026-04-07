import type { CanonicalActivityType } from "@dofek/training/training";
import type {
  FitbitActivity,
  FitbitDailySummary,
  FitbitSleepLog,
  FitbitWeightLog,
} from "./client.ts";

// ============================================================
// Parsed types
// ============================================================

export interface ParsedFitbitActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  calories: number;
  distanceKm?: number;
  steps?: number;
  averageHeartRate?: number;
  heartRateZones?: Array<{ name: string; min: number; max: number; minutes: number }>;
}

export interface ParsedFitbitSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes?: number;
  lightMinutes?: number;
  remMinutes?: number;
  awakeMinutes?: number;
  efficiencyPct: number;
  sleepType: "main" | "not_main";
  isNap: boolean;
}

export interface ParsedFitbitDailyMetrics {
  date: string;
  steps: number;
  restingHr?: number;
  activeEnergyKcal: number;
  exerciseMinutes: number;
  distanceKm?: number;
  flightsClimbed?: number;
}

export interface ParsedFitbitBodyMeasurement {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
  bodyFatPct?: number;
}

// ============================================================
// Activity type mapping
// ============================================================

const ACTIVITY_NAME_PATTERNS: Array<[RegExp, CanonicalActivityType]> = [
  [/\brun\b|treadmill/i, "running"],
  [/\bbike\b|cycling|spinning/i, "cycling"],
  [/\bwalk\b/i, "walking"],
  [/\bswim/i, "swimming"],
  [/\bhik[ei]/i, "hiking"],
  [/\byoga\b/i, "yoga"],
  [/\bweight|strength/i, "strength"],
  [/\belliptical\b/i, "elliptical"],
  [/\browing\b|row\b/i, "rowing"],
];

export function mapFitbitActivityType(
  activityName: string,
  _activityTypeId: number,
): CanonicalActivityType {
  for (const [pattern, type] of ACTIVITY_NAME_PATTERNS) {
    if (pattern.test(activityName)) {
      return type;
    }
  }
  return "other";
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function parseFitbitActivity(rawActivity: FitbitActivity): ParsedFitbitActivity {
  const startedAt = new Date(`${rawActivity.startDate}T${rawActivity.startTime}`);
  const endedAt = new Date(startedAt.getTime() + rawActivity.activeDuration);

  return {
    externalId: String(rawActivity.logId),
    activityType: mapFitbitActivityType(rawActivity.activityName, rawActivity.activityTypeId),
    name: rawActivity.activityName,
    startedAt,
    endedAt,
    calories: rawActivity.calories,
    distanceKm: rawActivity.distance,
    steps: rawActivity.steps,
    averageHeartRate: rawActivity.averageHeartRate,
    heartRateZones: rawActivity.heartRateZones,
  };
}

export function parseFitbitSleep(sleep: FitbitSleepLog): ParsedFitbitSleep {
  const summary = sleep.levels.summary;

  return {
    externalId: String(sleep.logId),
    startedAt: new Date(sleep.startTime),
    endedAt: new Date(sleep.endTime),
    durationMinutes: Math.round(sleep.duration / 60000),
    deepMinutes: summary.deep?.minutes,
    lightMinutes: summary.light?.minutes,
    remMinutes: summary.rem?.minutes,
    awakeMinutes: summary.wake?.minutes,
    efficiencyPct: sleep.efficiency,
    sleepType: sleep.isMainSleep ? "main" : "not_main",
    isNap: !sleep.isMainSleep,
  };
}

export function parseFitbitDailySummary(
  date: string,
  daily: FitbitDailySummary,
): ParsedFitbitDailyMetrics {
  const totalDistance = daily.summary.distances.find((distance) => distance.activity === "total");

  return {
    date,
    steps: daily.summary.steps,
    restingHr: daily.summary.restingHeartRate,
    activeEnergyKcal: daily.summary.activityCalories,
    exerciseMinutes: daily.summary.fairlyActiveMinutes + daily.summary.veryActiveMinutes,
    distanceKm: totalDistance?.distance,
    flightsClimbed: daily.summary.floors,
  };
}

export function parseFitbitWeightLog(log: FitbitWeightLog): ParsedFitbitBodyMeasurement {
  return {
    externalId: String(log.logId),
    recordedAt: new Date(`${log.date}T${log.time}`),
    weightKg: log.weight,
    bodyFatPct: log.fat,
  };
}
