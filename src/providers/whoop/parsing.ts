import type { CanonicalActivityType } from "@dofek/training/training";
import { mapSportId, mapV2ActivityType } from "whoop-whoop/sports";
import type {
  WhoopCycle,
  WhoopHrValue,
  WhoopRecoveryRecord,
  WhoopSleepRecord,
  WhoopWeightliftingWorkoutResponse,
  WhoopWorkoutRecord,
} from "whoop-whoop/types";
import { parseDuringRange } from "whoop-whoop/utils";
import { z } from "zod";

// ============================================================
// Parsing — pure functions (dofek-specific shapes)
// ============================================================

function milliToMinutes(milli: number): number {
  return Math.round(milli / 60000);
}

/**
 * Normalize a WHOOP efficiency value to the 0-100 percentage scale.
 * WHOOP sleep efficiency fields (`in_sleep_efficiency` and
 * `sleep_efficiency_percentage`) have been observed returning both
 * percentage (89.4) and fraction (0.894) formats. Values ≤ 1 are treated
 * as fractions and scaled to percentage.
 */
function normalizeEfficiencyPct(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  return value <= 1 ? Math.round(value * 1000) / 10 : value;
}

export interface ParsedRecovery {
  cycleId: number;
  restingHr?: number;
  hrv?: number;
  spo2?: number;
  skinTemp?: number;
}

/** Resolve the effective state field (API uses `score_state` or `state` depending on version) */
export function resolveRecoveryState(record: WhoopRecoveryRecord): string | undefined {
  return record.score_state ?? record.state;
}

export function parseRecovery(record: WhoopRecoveryRecord): ParsedRecovery {
  const state = resolveRecoveryState(record);

  // Legacy format: score_state === "SCORED" with nested `score` object
  if (state === "SCORED" && record.score) {
    return {
      cycleId: record.cycle_id ?? 0,
      restingHr: record.score.resting_heart_rate,
      hrv: record.score.hrv_rmssd_milli,
      spo2: record.score.spo2_percentage,
      skinTemp: record.score.skin_temp_celsius,
    };
  }
  // BFF v0 format: flat biometric fields at top level.
  // Accept any state value (or absent state) — the presence of resting_heart_rate
  // indicates scored recovery. The API has used "complete", no state, and other
  // values across different versions; keying on biometric data is more robust.
  if (record.resting_heart_rate != null) {
    return {
      cycleId: record.cycle_id ?? 0,
      restingHr: record.resting_heart_rate,
      // BFF returns hrv_rmssd in seconds; convert to milliseconds
      hrv: record.hrv_rmssd != null ? record.hrv_rmssd * 1000 : undefined,
      spo2: record.spo2_percentage ?? record.spo2,
      skinTemp: record.skin_temp_celsius,
    };
  }
  // Unscored or unrecognized format
  return { cycleId: record.cycle_id ?? 0 };
}

export interface ParsedSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  awakeMinutes: number;
  efficiencyPct?: number;
  sleepType: "sleep" | "nap";
  isNap: boolean;
  sleepNeedBaselineMinutes?: number;
  sleepNeedFromDebtMinutes?: number;
  sleepNeedFromStrainMinutes?: number;
  sleepNeedFromNapMinutes?: number;
}

export interface ParsedSleepStage {
  stage: "deep" | "light" | "rem" | "awake";
  startedAt: Date;
  endedAt: Date;
}

/** Map WHOOP stage names to canonical stages */
const WHOOP_STAGE_MAP: Record<string, "deep" | "light" | "rem" | "awake"> = {
  deep: "deep",
  slow_wave: "deep",
  light: "light",
  rem: "rem",
  awake: "awake",
};

export function parseSleepStages(record: WhoopSleepRecord): ParsedSleepStage[] {
  const stages: ParsedSleepStage[] = [];
  for (const s of record.stages ?? []) {
    const stage = WHOOP_STAGE_MAP[s.stage];
    if (!stage) continue;
    try {
      const { start, end } = parseDuringRange(s.during);
      stages.push({ stage, startedAt: start, endedAt: end });
    } catch {
      // Skip malformed stage rows from the API payload.
    }
  }
  return stages;
}

/**
 * Zod schema for inline sleep records from the BFF v0 cycle.sleeps array.
 * The sleep-service endpoint now returns raw stage data, so we parse from
 * the cycle response instead.
 */
export const inlineSleepSchema = z.object({
  during: z.string(),
  state: z.string().optional(),
  time_in_bed: z.number(),
  wake_duration: z.number(),
  light_sleep_duration: z.number(),
  slow_wave_sleep_duration: z.number(),
  rem_sleep_duration: z.number(),
  in_sleep_efficiency: z.number().optional(),
  sleep_need: z.number().optional(),
  habitual_sleep_need: z.number().optional(),
  debt_post: z.number().optional(),
  need_from_strain: z.number().optional(),
  credit_from_naps: z.number().optional(),
  significant: z.boolean().optional(),
});

export type InlineSleepRecord = z.infer<typeof inlineSleepSchema>;

/**
 * Parse an inline sleep record from the BFF v0 cycle.sleeps array.
 * This is the primary sleep parsing path since the sleep-service endpoint
 * changed to return raw stage arrays instead of summary objects.
 */
export function parseInlineSleep(
  record: InlineSleepRecord,
  sleepIndex: number,
): ParsedSleep | null {
  let range: { start: Date; end: Date };
  try {
    range = parseDuringRange(record.during);
  } catch {
    return null;
  }
  if (Number.isNaN(range.start.getTime()) || Number.isNaN(range.end.getTime())) {
    return null;
  }

  const durationMilli = record.time_in_bed - record.wake_duration;

  return {
    externalId: `inline-${range.start.toISOString()}-${sleepIndex}`,
    startedAt: range.start,
    endedAt: range.end,
    durationMinutes: milliToMinutes(durationMilli),
    deepMinutes: milliToMinutes(record.slow_wave_sleep_duration),
    remMinutes: milliToMinutes(record.rem_sleep_duration),
    lightMinutes: milliToMinutes(record.light_sleep_duration),
    awakeMinutes: milliToMinutes(record.wake_duration),
    efficiencyPct: normalizeEfficiencyPct(record.in_sleep_efficiency),
    sleepType: record.significant === false ? "nap" : "sleep",
    isNap: record.significant === false,
    sleepNeedBaselineMinutes:
      record.habitual_sleep_need != null ? milliToMinutes(record.habitual_sleep_need) : undefined,
    sleepNeedFromDebtMinutes:
      record.debt_post != null ? milliToMinutes(record.debt_post) : undefined,
    sleepNeedFromStrainMinutes:
      record.need_from_strain != null ? milliToMinutes(record.need_from_strain) : undefined,
    sleepNeedFromNapMinutes:
      record.credit_from_naps != null ? milliToMinutes(record.credit_from_naps) : undefined,
  };
}

/** Parse a sleep record from the legacy sleep-service API response. */
export function parseSleep(record: WhoopSleepRecord): ParsedSleep | null {
  // BFF v0 uses `during` range; fall back to legacy `start`/`end`
  let startedAt: Date;
  let endedAt: Date;
  if (record.during) {
    const range = parseDuringRange(record.during);
    startedAt = range.start;
    endedAt = range.end;
  } else {
    startedAt = new Date(record.start ?? "");
    endedAt = new Date(record.end ?? "");
  }

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }

  const stages = record.score?.stage_summary;
  const totalSleepMilli =
    (stages?.total_in_bed_time_milli ?? 0) - (stages?.total_awake_time_milli ?? 0);
  const sleepNeeded = record.score?.sleep_needed;

  return {
    externalId: String(record.id),
    startedAt,
    endedAt,
    durationMinutes: milliToMinutes(totalSleepMilli),
    deepMinutes: milliToMinutes(stages?.total_slow_wave_sleep_time_milli ?? 0),
    remMinutes: milliToMinutes(stages?.total_rem_sleep_time_milli ?? 0),
    lightMinutes: milliToMinutes(stages?.total_light_sleep_time_milli ?? 0),
    awakeMinutes: milliToMinutes(stages?.total_awake_time_milli ?? 0),
    efficiencyPct: normalizeEfficiencyPct(record.score?.sleep_efficiency_percentage),
    sleepType: record.nap ? "nap" : "sleep",
    isNap: record.nap,
    sleepNeedBaselineMinutes: sleepNeeded ? milliToMinutes(sleepNeeded.baseline_milli) : undefined,
    sleepNeedFromDebtMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_sleep_debt_milli)
      : undefined,
    sleepNeedFromStrainMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_recent_strain_milli)
      : undefined,
    sleepNeedFromNapMinutes: sleepNeeded
      ? milliToMinutes(sleepNeeded.need_from_recent_nap_milli)
      : undefined,
  };
}

export interface ParsedWorkout {
  externalId: string;
  activityType: CanonicalActivityType;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  totalElevationGain?: number;
}

/**
 * Resolve the canonical activity type for a WHOOP workout.
 * Uses sport_id as the primary source; falls back to the v2_activity type
 * name when the sport_id is unknown or maps to "other".
 */
export function resolveActivityType(
  sportId: number,
  v2ActivityTypeName?: string,
): CanonicalActivityType {
  const fromSportId = mapSportId(sportId);
  if (fromSportId !== "other") return fromSportId;

  if (v2ActivityTypeName) {
    const fromTypeName = mapV2ActivityType(v2ActivityTypeName);
    if (fromTypeName) return fromTypeName;
  }

  return "other";
}

export function parseWorkout(
  record: WhoopWorkoutRecord,
  v2ActivityTypeName?: string,
): ParsedWorkout | null {
  // BFF v0 uses `during` range; fall back to legacy `start`/`end`
  let startedAt: Date;
  let endedAt: Date;
  if (record.during) {
    const range = parseDuringRange(record.during);
    startedAt = range.start;
    endedAt = range.end;
  } else {
    startedAt = new Date(record.start ?? record.created_at ?? "");
    endedAt = new Date(record.end ?? record.updated_at ?? "");
  }

  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }

  return {
    externalId: record.activity_id ?? String(record.id ?? ""),
    activityType: resolveActivityType(record.sport_id, v2ActivityTypeName),
    startedAt,
    endedAt,
    durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    distanceMeters: undefined, // BFF v0 doesn't include distance at top level
    calories: record.kilojoules ? Math.round(record.kilojoules / 4.184) : undefined,
    avgHeartRate: record.average_heart_rate,
    maxHeartRate: record.max_heart_rate,
    totalElevationGain: undefined,
  };
}

export interface ParsedHrRecord {
  recordedAt: Date;
  heartRate: number;
}

export function parseHeartRateValues(values: WhoopHrValue[]): ParsedHrRecord[] {
  return values.map((v) => ({
    recordedAt: new Date(v.time),
    heartRate: v.data,
  }));
}

/**
 * WHOOP has multiple cycle shapes:
 * - legacy: cycle.sleep.id
 * - BFF v0: cycle.recovery.sleep_id
 * - v2 activities: cycle.v2_activities[*].id where activity is sleep-related
 */
export function extractSleepIdsFromCycle(cycle: WhoopCycle): string[] {
  const ids = new Set<string>();

  if (cycle.sleep?.id != null) {
    ids.add(String(cycle.sleep.id));
  }

  if (cycle.recovery?.sleep_id != null) {
    ids.add(String(cycle.recovery.sleep_id));
  }

  for (const activity of cycle.v2_activities ?? []) {
    const activityType = activity.type.toLowerCase();
    const scoreType = activity.score_type.toLowerCase();
    const isSleepActivity = scoreType === "sleep" || activityType.includes("sleep");
    if (isSleepActivity && activity.id) {
      ids.add(activity.id);
    }
  }

  return [...ids];
}

// ============================================================
// v2_activity type lookup
// ============================================================

/**
 * Build a Map from activity_id → v2_activity type name from all cycles.
 * Used as a fallback for activity type resolution when sport_id is
 * unknown or maps to "other".
 */
export function buildV2ActivityTypeLookup(cycles: WhoopCycle[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const cycle of cycles) {
    for (const v2Activity of cycle.v2_activities ?? []) {
      if (v2Activity.id && v2Activity.type) {
        lookup.set(v2Activity.id, v2Activity.type);
      }
    }
  }
  return lookup;
}

// ============================================================
// Weightlifting parsing
// ============================================================

export interface ParsedStrengthExercise {
  exerciseName: string;
  equipment: string | null;
  providerExerciseId: string;
  exerciseIndex: number;
  muscleGroups: string[];
  exerciseType: string;
  sets: ParsedStrengthSet[];
}

export interface ParsedStrengthSet {
  setIndex: number;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  strapLocation: string | null;
  strapLocationLaterality: string | null;
}

export interface ParsedWeightliftingWorkout {
  activityId: string;
  exercises: ParsedStrengthExercise[];
  rawMskStrainScore: number;
  scaledMskStrainScore: number;
  cardioStrainScore: number;
  cardioStrainContributionPercent: number;
  mskStrainContributionPercent: number;
}

export function parseWeightliftingWorkout(
  response: WhoopWeightliftingWorkoutResponse,
): ParsedWeightliftingWorkout {
  const exercises: ParsedStrengthExercise[] = [];
  let exerciseIndex = 0;

  for (const group of response.workout_groups) {
    for (const workoutExercise of group.workout_exercises) {
      const details = workoutExercise.exercise_details;
      const isTimeFormat = details.volume_input_format === "TIME";

      const sets: ParsedStrengthSet[] = [];
      let setIndex = 0;
      for (const set of workoutExercise.sets) {
        if (!set.complete) continue;

        sets.push({
          setIndex,
          weightKg: set.weight_kg > 0 ? set.weight_kg : null,
          reps: set.number_of_reps > 0 ? set.number_of_reps : null,
          durationSeconds: isTimeFormat && set.time_in_seconds > 0 ? set.time_in_seconds : null,
          strapLocation: set.strap_location ?? null,
          strapLocationLaterality: set.strap_location_laterality ?? null,
        });
        setIndex++;
      }

      exercises.push({
        exerciseName: details.name,
        equipment: details.equipment || null,
        providerExerciseId: details.exercise_id,
        exerciseIndex,
        muscleGroups: details.muscle_groups,
        exerciseType: details.exercise_type,
        sets,
      });
      exerciseIndex++;
    }
  }

  return {
    activityId: response.activity_id,
    exercises,
    rawMskStrainScore: response.raw_msk_strain_score,
    scaledMskStrainScore: response.scaled_msk_strain_score,
    cardioStrainScore: response.cardio_strain_score,
    cardioStrainContributionPercent: response.cardio_strain_contribution_percent,
    mskStrainContributionPercent: response.msk_strain_contribution_percent,
  };
}
