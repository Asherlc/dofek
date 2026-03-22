/**
 * Canonical daily metric type catalog — single source of truth for all
 * metric types that can appear in the daily_metrics table.
 *
 * Each daily_metrics "row" represents one provider+source reporting for a day.
 * The actual values are stored in a junction table keyed by metric type id.
 *
 * Key concept: metrics have a `priorityCategory` that determines how the
 * dedup view selects the best value when multiple providers report the same
 * metric for the same day. "recovery" metrics use recovery_priority,
 * "activity" metrics use daily_activity_priority.
 */

export type DailyMetricCategory = "recovery" | "activity" | "gait" | "audio" | "stress" | "other";

export type PriorityCategory = "recovery" | "activity";

export interface DailyMetricTypeDefinition {
  /** Stable identifier, used as DB primary key. e.g. 'resting_hr', 'steps' */
  readonly id: string;
  /** Human-readable name. e.g. 'Resting Heart Rate', 'Steps' */
  readonly displayName: string;
  /** Unit of measurement. e.g. 'bpm', 'steps', 'kcal' */
  readonly unit: string;
  /** Grouping category for UI sections */
  readonly category: DailyMetricCategory;
  /** Which priority column to use for dedup in the view */
  readonly priorityCategory: PriorityCategory;
  /** Sort order within category for consistent UI rendering */
  readonly sortOrder: number;
  /** Whether the value is an integer (true) or real number (false) */
  readonly isInteger: boolean;
  /** Legacy camelCase field name on the daily_metrics schema. e.g. 'restingHr' */
  readonly legacyFieldName: string;
  /** Legacy snake_case DB column name. e.g. 'resting_hr' */
  readonly legacyColumnName: string;
}

// ── Recovery / health metrics ───────────────────────────────────────────────

const RECOVERY: DailyMetricTypeDefinition[] = [
  {
    id: "resting_hr",
    displayName: "Resting Heart Rate",
    unit: "bpm",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 100,
    isInteger: true,
    legacyFieldName: "restingHr",
    legacyColumnName: "resting_hr",
  },
  {
    id: "hrv",
    displayName: "Heart Rate Variability",
    unit: "ms",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 101,
    isInteger: false,
    legacyFieldName: "hrv",
    legacyColumnName: "hrv",
  },
  {
    id: "vo2max",
    displayName: "VO2max",
    unit: "ml/kg/min",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 102,
    isInteger: false,
    legacyFieldName: "vo2max",
    legacyColumnName: "vo2max",
  },
  {
    id: "spo2_avg",
    displayName: "Blood Oxygen (SpO2)",
    unit: "%",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 103,
    isInteger: false,
    legacyFieldName: "spo2Avg",
    legacyColumnName: "spo2_avg",
  },
  {
    id: "respiratory_rate_avg",
    displayName: "Respiratory Rate",
    unit: "breaths/min",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 104,
    isInteger: false,
    legacyFieldName: "respiratoryRateAvg",
    legacyColumnName: "respiratory_rate_avg",
  },
  {
    id: "skin_temp_c",
    displayName: "Skin Temperature",
    unit: "°C",
    category: "recovery",
    priorityCategory: "recovery",
    sortOrder: 105,
    isInteger: false,
    legacyFieldName: "skinTempC",
    legacyColumnName: "skin_temp_c",
  },
];

// ── Activity metrics ────────────────────────────────────────────────────────

const ACTIVITY: DailyMetricTypeDefinition[] = [
  {
    id: "steps",
    displayName: "Steps",
    unit: "steps",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 200,
    isInteger: true,
    legacyFieldName: "steps",
    legacyColumnName: "steps",
  },
  {
    id: "active_energy_kcal",
    displayName: "Active Calories",
    unit: "kcal",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 201,
    isInteger: false,
    legacyFieldName: "activeEnergyKcal",
    legacyColumnName: "active_energy_kcal",
  },
  {
    id: "basal_energy_kcal",
    displayName: "Basal Calories",
    unit: "kcal",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 202,
    isInteger: false,
    legacyFieldName: "basalEnergyKcal",
    legacyColumnName: "basal_energy_kcal",
  },
  {
    id: "distance_km",
    displayName: "Walking + Running Distance",
    unit: "km",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 203,
    isInteger: false,
    legacyFieldName: "distanceKm",
    legacyColumnName: "distance_km",
  },
  {
    id: "cycling_distance_km",
    displayName: "Cycling Distance",
    unit: "km",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 204,
    isInteger: false,
    legacyFieldName: "cyclingDistanceKm",
    legacyColumnName: "cycling_distance_km",
  },
  {
    id: "flights_climbed",
    displayName: "Flights Climbed",
    unit: "flights",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 205,
    isInteger: true,
    legacyFieldName: "flightsClimbed",
    legacyColumnName: "flights_climbed",
  },
  {
    id: "exercise_minutes",
    displayName: "Exercise Minutes",
    unit: "min",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 206,
    isInteger: true,
    legacyFieldName: "exerciseMinutes",
    legacyColumnName: "exercise_minutes",
  },
  {
    id: "mindful_minutes",
    displayName: "Mindful Minutes",
    unit: "min",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 207,
    isInteger: true,
    legacyFieldName: "mindfulMinutes",
    legacyColumnName: "mindful_minutes",
  },
  {
    id: "stand_hours",
    displayName: "Stand Hours",
    unit: "hours",
    category: "activity",
    priorityCategory: "activity",
    sortOrder: 208,
    isInteger: true,
    legacyFieldName: "standHours",
    legacyColumnName: "stand_hours",
  },
];

// ── Walking gait metrics ────────────────────────────────────────────────────

const GAIT: DailyMetricTypeDefinition[] = [
  {
    id: "walking_speed",
    displayName: "Walking Speed",
    unit: "m/s",
    category: "gait",
    priorityCategory: "activity",
    sortOrder: 300,
    isInteger: false,
    legacyFieldName: "walkingSpeed",
    legacyColumnName: "walking_speed",
  },
  {
    id: "walking_step_length",
    displayName: "Walking Step Length",
    unit: "cm",
    category: "gait",
    priorityCategory: "activity",
    sortOrder: 301,
    isInteger: false,
    legacyFieldName: "walkingStepLength",
    legacyColumnName: "walking_step_length",
  },
  {
    id: "walking_double_support_pct",
    displayName: "Walking Double Support",
    unit: "%",
    category: "gait",
    priorityCategory: "activity",
    sortOrder: 302,
    isInteger: false,
    legacyFieldName: "walkingDoubleSupportPct",
    legacyColumnName: "walking_double_support_pct",
  },
  {
    id: "walking_asymmetry_pct",
    displayName: "Walking Asymmetry",
    unit: "%",
    category: "gait",
    priorityCategory: "activity",
    sortOrder: 303,
    isInteger: false,
    legacyFieldName: "walkingAsymmetryPct",
    legacyColumnName: "walking_asymmetry_pct",
  },
  {
    id: "walking_steadiness",
    displayName: "Walking Steadiness",
    unit: "",
    category: "gait",
    priorityCategory: "activity",
    sortOrder: 304,
    isInteger: false,
    legacyFieldName: "walkingSteadiness",
    legacyColumnName: "walking_steadiness",
  },
];

// ── Audio exposure ──────────────────────────────────────────────────────────

const AUDIO: DailyMetricTypeDefinition[] = [
  {
    id: "environmental_audio_exposure",
    displayName: "Environmental Audio Exposure",
    unit: "dBASPL",
    category: "audio",
    priorityCategory: "activity",
    sortOrder: 400,
    isInteger: false,
    legacyFieldName: "environmentalAudioExposure",
    legacyColumnName: "environmental_audio_exposure",
  },
  {
    id: "headphone_audio_exposure",
    displayName: "Headphone Audio Exposure",
    unit: "dBASPL",
    category: "audio",
    priorityCategory: "activity",
    sortOrder: 401,
    isInteger: false,
    legacyFieldName: "headphoneAudioExposure",
    legacyColumnName: "headphone_audio_exposure",
  },
];

// ── Stress / resilience ─────────────────────────────────────────────────────

const STRESS: DailyMetricTypeDefinition[] = [
  {
    id: "stress_high_minutes",
    displayName: "High Stress Minutes",
    unit: "min",
    category: "stress",
    priorityCategory: "recovery",
    sortOrder: 500,
    isInteger: true,
    legacyFieldName: "stressHighMinutes",
    legacyColumnName: "stress_high_minutes",
  },
  {
    id: "recovery_high_minutes",
    displayName: "High Recovery Minutes",
    unit: "min",
    category: "stress",
    priorityCategory: "recovery",
    sortOrder: 501,
    isInteger: true,
    legacyFieldName: "recoveryHighMinutes",
    legacyColumnName: "recovery_high_minutes",
  },
];

// ── Exported catalog ────────────────────────────────────────────────────────

/** Complete catalog of all daily metric types, sorted by category then sortOrder. */
export const DAILY_METRIC_TYPES: readonly DailyMetricTypeDefinition[] = [
  ...RECOVERY,
  ...ACTIVITY,
  ...GAIT,
  ...AUDIO,
  ...STRESS,
] as const;

// ── Lookup indexes (built once at import time) ──────────────────────────────

const byId = new Map<string, DailyMetricTypeDefinition>();
const byLegacyField = new Map<string, DailyMetricTypeDefinition>();
const byLegacyColumn = new Map<string, DailyMetricTypeDefinition>();

for (const metricType of DAILY_METRIC_TYPES) {
  byId.set(metricType.id, metricType);
  byLegacyField.set(metricType.legacyFieldName, metricType);
  byLegacyColumn.set(metricType.legacyColumnName, metricType);
}

/** Look up a daily metric type by its stable id (e.g. 'resting_hr'). */
export function getDailyMetricTypeById(id: string): DailyMetricTypeDefinition | null {
  return byId.get(id) ?? null;
}

/** Look up a daily metric type by its legacy camelCase field name (e.g. 'restingHr'). */
export function getDailyMetricTypeByLegacyField(
  fieldName: string,
): DailyMetricTypeDefinition | null {
  return byLegacyField.get(fieldName) ?? null;
}

/**
 * Convert a flat object with legacy camelCase daily metric fields
 * (e.g. { restingHr: 58, steps: 8200 }) into the normalized map
 * (e.g. { resting_hr: 58, steps: 8200 }).
 */
export function legacyFieldsToDailyMetrics(
  fields: Record<string, unknown>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value == null || typeof value !== "number") continue;
    const definition = byLegacyField.get(fieldName);
    if (definition) {
      metrics[definition.id] = value;
    }
  }
  return metrics;
}
