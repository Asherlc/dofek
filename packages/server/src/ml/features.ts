/**
 * Feature extraction for ML models.
 *
 * Defines all available features and prediction targets. Each target
 * specifies which features to exclude (the target itself + correlated metrics)
 * so the model surfaces genuinely controllable factors.
 */

export interface FeatureDefinition {
  name: string;
  description: string;
  extract: (day: DailyFeatureRow) => number | null;
}

/** Minimal row shape needed for feature extraction — mirrors JoinedDay from insights/engine */
export interface DailyFeatureRow {
  date: string;
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
  sleep_duration_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  sleep_efficiency: number | null;
  exercise_minutes: number | null;
  cardio_minutes: number | null;
  strength_minutes: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  weight_kg: number | null;
}

export interface ExtractedDataset {
  featureNames: string[];
  X: number[][];
  y: number[];
  dates: string[];
}

export interface PredictionTarget {
  id: string;
  label: string;
  unit: string;
  /** Extract the target value from next day's data */
  extractTarget: (day: DailyFeatureRow) => number | null;
  /** Feature names to exclude (the target itself + trivially correlated metrics) */
  excludeFeatures: string[];
}

/** All available features that can be used as predictors */
export function getAllFeatures(): FeatureDefinition[] {
  return [
    // Vitals
    {
      name: "hrv",
      description: "Heart rate variability (ms)",
      extract: (d) => d.hrv,
    },
    {
      name: "resting_hr",
      description: "Resting heart rate",
      extract: (d) => d.resting_hr,
    },
    {
      name: "skin_temp",
      description: "Skin temperature (°C)",
      extract: (d) => d.skin_temp_c,
    },
    // Sleep
    {
      name: "sleep_duration",
      description: "Sleep duration (minutes)",
      extract: (d) => d.sleep_duration_min,
    },
    {
      name: "deep_sleep",
      description: "Deep sleep (minutes)",
      extract: (d) => d.deep_min,
    },
    {
      name: "rem_sleep",
      description: "REM sleep (minutes)",
      extract: (d) => d.rem_min,
    },
    {
      name: "sleep_efficiency",
      description: "Sleep efficiency (%)",
      extract: (d) => d.sleep_efficiency,
    },
    // Activity
    {
      name: "exercise_minutes",
      description: "Total exercise duration",
      extract: (d) => d.exercise_minutes,
    },
    {
      name: "cardio_minutes",
      description: "Cardio exercise duration",
      extract: (d) => d.cardio_minutes,
    },
    {
      name: "strength_minutes",
      description: "Strength training duration",
      extract: (d) => d.strength_minutes,
    },
    {
      name: "active_kcal",
      description: "Active energy burned (kcal)",
      extract: (d) => d.active_energy_kcal,
    },
    {
      name: "steps",
      description: "Daily step count",
      extract: (d) => d.steps,
    },
    // Nutrition
    {
      name: "calories",
      description: "Caloric intake",
      extract: (d) => d.calories,
    },
    {
      name: "protein_g",
      description: "Protein intake (g)",
      extract: (d) => d.protein_g,
    },
    {
      name: "carbs_g",
      description: "Carb intake (g)",
      extract: (d) => d.carbs_g,
    },
    {
      name: "fat_g",
      description: "Fat intake (g)",
      extract: (d) => d.fat_g,
    },
    {
      name: "fiber_g",
      description: "Fiber intake (g)",
      extract: (d) => d.fiber_g,
    },
    // Body composition
    {
      name: "weight_kg",
      description: "Body weight (kg)",
      extract: (d) => d.weight_kg,
    },
  ];
}

export const PREDICTION_TARGETS: PredictionTarget[] = [
  {
    id: "hrv",
    label: "HRV",
    unit: "ms",
    extractTarget: (d) => d.hrv,
    // Exclude HRV itself + resting HR (bidirectionally correlated via autonomic nervous system)
    excludeFeatures: ["hrv", "resting_hr"],
  },
  {
    id: "resting_hr",
    label: "Resting Heart Rate",
    unit: "bpm",
    extractTarget: (d) => d.resting_hr,
    excludeFeatures: ["resting_hr", "hrv"],
  },
  {
    id: "sleep_efficiency",
    label: "Sleep Efficiency",
    unit: "%",
    extractTarget: (d) => d.sleep_efficiency,
    // Exclude all sleep metrics — they're outputs of the same sleep session
    excludeFeatures: ["sleep_efficiency", "sleep_duration", "deep_sleep", "rem_sleep"],
  },
  {
    id: "weight",
    label: "Body Weight",
    unit: "kg",
    extractTarget: (d) => d.weight_kg,
    // Exclude weight itself — we want to know what drives weight change
    excludeFeatures: ["weight_kg"],
  },
];

export function getPredictionTarget(id: string): PredictionTarget | undefined {
  return PREDICTION_TARGETS.find((t) => t.id === id);
}

/**
 * Build a dataset for next-day prediction of the given target.
 *
 * For each day i where both features and next-day target are available,
 * creates a feature vector from day i and target from day i+1.
 *
 * Features with >50% missing values are dropped entirely.
 * Remaining missing values are imputed with the feature's column mean.
 */
export function buildDataset(
  days: DailyFeatureRow[],
  target: PredictionTarget,
  minCompleteness: number = 0.5,
): ExtractedDataset | null {
  const excludeSet = new Set(target.excludeFeatures);
  const featureDefs = getAllFeatures().filter((f) => !excludeSet.has(f.name));

  const rawRows: { features: (number | null)[]; target: number; date: string }[] = [];

  for (let i = 0; i < days.length - 1; i++) {
    const today = days[i]!;
    const tomorrow = days[i + 1]!;
    const targetValue = target.extractTarget(tomorrow);
    if (targetValue == null) continue;

    const features = featureDefs.map((f) => f.extract(today));
    rawRows.push({ features, target: targetValue, date: today.date });
  }

  if (rawRows.length < 20) return null;

  // Determine which features to keep (>minCompleteness non-null)
  const nRows = rawRows.length;
  const nFeatures = featureDefs.length;
  const keptIndices: number[] = [];
  const keptNames: string[] = [];

  for (let f = 0; f < nFeatures; f++) {
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

  // Build final dataset with imputation
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
