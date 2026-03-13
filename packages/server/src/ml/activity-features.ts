/**
 * Activity-level feature extraction for ML predictions.
 *
 * Unlike daily features (which predict tomorrow from today), activity features
 * predict the outcome of a specific workout/session from trailing context:
 * recent sleep, nutrition, training load, and recovery metrics.
 */

import type { ExtractedDataset } from "./features.ts";

// ── Row types ────────────────────────────────────────────────────────────

export interface CardioActivityRow {
  date: string;
  activityType: string;
  durationMin: number;
  avgHr: number | null;
  avgPower: number | null;
  avgSpeed: number | null;
  totalDistance: number | null;
  elevationGain: number | null;
  avgCadence: number | null;
}

export interface StrengthWorkoutRow {
  date: string;
  totalVolume: number;
  workingSetCount: number;
  maxWeight: number | null;
  avgRpe: number | null;
}

export type ActivityRow = CardioActivityRow | StrengthWorkoutRow;

/** Daily context data used to build trailing features for each activity */
export interface DailyContext {
  date: string;
  hrv: number | null;
  restingHr: number | null;
  sleepDurationMin: number | null;
  deepMin: number | null;
  sleepEfficiency: number | null;
  calories: number | null;
  proteinG: number | null;
  weightKg: number | null;
  exerciseMinutes: number | null;
  steps: number | null;
}

// ── Feature definitions ──────────────────────────────────────────────────

interface ActivityFeatureDef {
  name: string;
  extract: (activity: ActivityRow, trailingContext: DailyContext[]) => number | null;
}

/** Compute mean of a field across context days, ignoring nulls */
function trailingMean(
  context: DailyContext[],
  field: keyof DailyContext,
  lastN: number,
): number | null {
  const recent = context.slice(-lastN);
  let sum = 0;
  let count = 0;
  for (const day of recent) {
    const val = day[field];
    if (typeof val === "number") {
      sum += val;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/** Features derived from trailing daily context (shared across all activity types) */
function getContextFeatures(): ActivityFeatureDef[] {
  return [
    // Recovery (3-day trailing averages)
    {
      name: "hrv_3d",
      extract: (_, ctx) => trailingMean(ctx, "hrv", 3),
    },
    {
      name: "resting_hr_3d",
      extract: (_, ctx) => trailingMean(ctx, "restingHr", 3),
    },
    // Sleep (3-day trailing)
    {
      name: "sleep_duration_3d",
      extract: (_, ctx) => trailingMean(ctx, "sleepDurationMin", 3),
    },
    {
      name: "deep_sleep_3d",
      extract: (_, ctx) => trailingMean(ctx, "deepMin", 3),
    },
    {
      name: "sleep_efficiency_3d",
      extract: (_, ctx) => trailingMean(ctx, "sleepEfficiency", 3),
    },
    // Nutrition (3-day trailing)
    {
      name: "calories_3d",
      extract: (_, ctx) => trailingMean(ctx, "calories", 3),
    },
    {
      name: "protein_3d",
      extract: (_, ctx) => trailingMean(ctx, "proteinG", 3),
    },
    // Body
    {
      name: "weight_kg",
      extract: (_, ctx) => trailingMean(ctx, "weightKg", 3),
    },
    // General activity level (7-day trailing)
    {
      name: "exercise_minutes_7d",
      extract: (_, ctx) => trailingMean(ctx, "exerciseMinutes", 7),
    },
    {
      name: "steps_7d",
      extract: (_, ctx) => trailingMean(ctx, "steps", 7),
    },
  ];
}

/** Cardio-specific features (from the activity itself or recent sessions) */
function getCardioFeatures(): ActivityFeatureDef[] {
  return [
    {
      name: "duration_min",
      extract: (a) => (a as CardioActivityRow).durationMin,
    },
    {
      name: "avg_hr",
      extract: (a) => (a as CardioActivityRow).avgHr,
    },
    {
      name: "avg_speed",
      extract: (a) => (a as CardioActivityRow).avgSpeed,
    },
    {
      name: "total_distance",
      extract: (a) => (a as CardioActivityRow).totalDistance,
    },
    {
      name: "elevation_gain",
      extract: (a) => (a as CardioActivityRow).elevationGain,
    },
    {
      name: "avg_cadence",
      extract: (a) => (a as CardioActivityRow).avgCadence,
    },
  ];
}

/** Strength-specific features */
function getStrengthFeatures(): ActivityFeatureDef[] {
  return [
    {
      name: "working_set_count",
      extract: (a) => (a as StrengthWorkoutRow).workingSetCount,
    },
    {
      name: "max_weight",
      extract: (a) => (a as StrengthWorkoutRow).maxWeight,
    },
    {
      name: "avg_rpe",
      extract: (a) => (a as StrengthWorkoutRow).avgRpe,
    },
  ];
}

// ── Targets ──────────────────────────────────────────────────────────────

export interface ActivityPredictionTarget {
  id: string;
  label: string;
  unit: string;
  activityType: "cardio" | "strength";
  extractTarget: (activity: ActivityRow) => number | null;
  /** Feature names to exclude from this target (the target metric itself) */
  excludeFeatures: string[];
}

export const ACTIVITY_PREDICTION_TARGETS: ActivityPredictionTarget[] = [
  {
    id: "cardio_power",
    label: "Cardio Power Output",
    unit: "W",
    activityType: "cardio",
    extractTarget: (a) => (a as CardioActivityRow).avgPower,
    excludeFeatures: ["avg_power"],
  },
  {
    id: "strength_volume",
    label: "Strength Training Volume",
    unit: "kg",
    activityType: "strength",
    extractTarget: (a) => (a as StrengthWorkoutRow).totalVolume,
    excludeFeatures: ["total_volume"],
  },
];

// ── Dataset builder ──────────────────────────────────────────────────────

/**
 * Build a dataset for activity-level prediction.
 *
 * For each activity, computes trailing features from recent daily context
 * (sleep, nutrition, recovery metrics from days leading up to the session).
 *
 * Requires at least 3 days of context before the first activity.
 * Features with >50% missing values are dropped.
 */
export function buildActivityDataset(
  activities: ActivityRow[],
  dailyContext: DailyContext[],
  target: ActivityPredictionTarget,
  minCompleteness: number = 0.5,
): ExtractedDataset | null {
  // Build date → index map for quick context lookup
  const dateIndex = new Map<string, number>();
  for (let i = 0; i < dailyContext.length; i++) {
    dateIndex.set(dailyContext[i]!.date, i);
  }

  // Select feature definitions based on activity type
  const excludeSet = new Set(target.excludeFeatures);
  const activityFeatures =
    target.activityType === "cardio" ? getCardioFeatures() : getStrengthFeatures();
  const allFeatures = [...getContextFeatures(), ...activityFeatures].filter(
    (f) => !excludeSet.has(f.name),
  );

  // Also add trailing metrics from previous sessions
  const sessionFeatures = getTrailingSessionFeatures(activities, target);
  const featureDefs = [...allFeatures, ...sessionFeatures].filter(
    (f) => !excludeSet.has(f.name),
  );

  // Build raw rows
  const rawRows: { features: (number | null)[]; target: number; date: string }[] = [];

  for (let i = 0; i < activities.length; i++) {
    const activity = activities[i]!;
    const targetValue = target.extractTarget(activity);
    if (targetValue == null) continue;

    // Get trailing daily context (up to 7 days before this activity)
    const dayIdx = dateIndex.get(activity.date);
    if (dayIdx == null || dayIdx < 3) continue; // Need at least 3 days of context

    const trailingContext = dailyContext.slice(Math.max(0, dayIdx - 7), dayIdx);
    const features = featureDefs.map((f) => f.extract(activity, trailingContext));
    rawRows.push({ features, target: targetValue, date: activity.date });
  }

  if (rawRows.length < 20) return null;

  // Drop features with too many missing values
  const nRows = rawRows.length;
  const keptIndices: number[] = [];
  const keptNames: string[] = [];

  for (let f = 0; f < featureDefs.length; f++) {
    let nonNull = 0;
    for (const row of rawRows) {
      if (row.features[f] != null) nonNull++;
    }
    if (nonNull / nRows >= minCompleteness) {
      keptIndices.push(f);
      keptNames.push(featureDefs[f]!.name);
    }
  }

  if (keptIndices.length === 0) return null;

  // Compute column means for imputation
  const columnMeans = keptIndices.map((f) => {
    let sum = 0;
    let count = 0;
    for (const row of rawRows) {
      const val = row.features[f];
      if (val != null) {
        sum += val;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  });

  // Build imputed dataset
  const X: number[][] = [];
  const y: number[] = [];
  const dates: string[] = [];

  for (const row of rawRows) {
    const featureVec = keptIndices.map((f, j) => {
      const val = row.features[f];
      return val ?? columnMeans[j]!;
    });
    X.push(featureVec);
    y.push(row.target);
    dates.push(row.date);
  }

  return { featureNames: keptNames, X, y, dates };
}

/**
 * Build features from trailing sessions (e.g., days since last session,
 * trailing session count, previous session's target value).
 */
function getTrailingSessionFeatures(
  activities: ActivityRow[],
  target: ActivityPredictionTarget,
): ActivityFeatureDef[] {
  return [
    {
      name: "days_since_last_session",
      extract: (activity) => {
        const idx = activities.indexOf(activity);
        if (idx <= 0) return null;
        const prev = activities[idx - 1]!;
        const daysDiff =
          (new Date(activity.date).getTime() - new Date(prev.date).getTime()) /
          (1000 * 60 * 60 * 24);
        return daysDiff;
      },
    },
    {
      name: "prev_session_target",
      extract: (activity) => {
        const idx = activities.indexOf(activity);
        if (idx <= 0) return null;
        return target.extractTarget(activities[idx - 1]!);
      },
    },
    {
      name: "sessions_last_14d",
      extract: (activity) => {
        const activityDate = new Date(activity.date).getTime();
        const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
        let count = 0;
        for (const a of activities) {
          const d = new Date(a.date).getTime();
          if (d < activityDate && activityDate - d <= fourteenDaysMs) count++;
        }
        return count;
      },
    },
  ];
}
