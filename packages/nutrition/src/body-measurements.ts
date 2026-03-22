/**
 * Canonical body measurement type catalog — single source of truth for all
 * measurement types that can be recorded in a body measurement event.
 *
 * Each body measurement "event" (e.g., stepping on a scale) can produce
 * multiple values (weight, body fat %, muscle mass, etc.). The values are
 * stored in a junction table keyed by measurement type id.
 */

export type MeasurementCategory = "composition" | "dimension" | "cardiovascular" | "temperature";

export interface MeasurementTypeDefinition {
  /** Stable identifier, used as DB primary key. e.g. 'weight', 'body_fat_pct' */
  readonly id: string;
  /** Human-readable name. e.g. 'Weight', 'Body Fat' */
  readonly displayName: string;
  /** Unit of measurement. e.g. 'kg', '%', 'cm'. Null for dimensionless values. */
  readonly unit: string | null;
  /** Grouping category for UI sections */
  readonly category: MeasurementCategory;
  /** Sort order within category for consistent UI rendering */
  readonly sortOrder: number;
  /** Legacy camelCase field name on the body_measurement schema. e.g. 'weightKg' */
  readonly legacyFieldName: string;
  /** Legacy snake_case DB column name. e.g. 'weight_kg' */
  readonly legacyColumnName: string;
  /** Whether the value is an integer (true) or real number (false) */
  readonly isInteger: boolean;
}

// ── Body composition ────────────────────────────────────────────────────────

const COMPOSITION: MeasurementTypeDefinition[] = [
  {
    id: "weight",
    displayName: "Weight",
    unit: "kg",
    category: "composition",
    sortOrder: 100,
    legacyFieldName: "weightKg",
    legacyColumnName: "weight_kg",
    isInteger: false,
  },
  {
    id: "body_fat_pct",
    displayName: "Body Fat",
    unit: "%",
    category: "composition",
    sortOrder: 101,
    legacyFieldName: "bodyFatPct",
    legacyColumnName: "body_fat_pct",
    isInteger: false,
  },
  {
    id: "muscle_mass",
    displayName: "Muscle Mass",
    unit: "kg",
    category: "composition",
    sortOrder: 102,
    legacyFieldName: "muscleMassKg",
    legacyColumnName: "muscle_mass_kg",
    isInteger: false,
  },
  {
    id: "bone_mass",
    displayName: "Bone Mass",
    unit: "kg",
    category: "composition",
    sortOrder: 103,
    legacyFieldName: "boneMassKg",
    legacyColumnName: "bone_mass_kg",
    isInteger: false,
  },
  {
    id: "water_pct",
    displayName: "Water",
    unit: "%",
    category: "composition",
    sortOrder: 104,
    legacyFieldName: "waterPct",
    legacyColumnName: "water_pct",
    isInteger: false,
  },
  {
    id: "bmi",
    displayName: "BMI",
    unit: "kg/m²",
    category: "composition",
    sortOrder: 105,
    legacyFieldName: "bmi",
    legacyColumnName: "bmi",
    isInteger: false,
  },
  {
    id: "lean_body_mass",
    displayName: "Lean Body Mass",
    unit: "kg",
    category: "composition",
    sortOrder: 106,
    legacyFieldName: "leanBodyMassKg",
    legacyColumnName: "lean_body_mass_kg",
    isInteger: false,
  },
  {
    id: "visceral_fat",
    displayName: "Visceral Fat Rating",
    unit: null,
    category: "composition",
    sortOrder: 107,
    legacyFieldName: "visceralFat",
    legacyColumnName: "visceral_fat",
    isInteger: false,
  },
  {
    id: "metabolic_age",
    displayName: "Metabolic Age",
    unit: "years",
    category: "composition",
    sortOrder: 108,
    legacyFieldName: "metabolicAge",
    legacyColumnName: "metabolic_age",
    isInteger: true,
  },
];

// ── Dimensions ──────────────────────────────────────────────────────────────

const DIMENSIONS: MeasurementTypeDefinition[] = [
  {
    id: "height",
    displayName: "Height",
    unit: "cm",
    category: "dimension",
    sortOrder: 200,
    legacyFieldName: "heightCm",
    legacyColumnName: "height_cm",
    isInteger: false,
  },
  {
    id: "waist_circumference",
    displayName: "Waist Circumference",
    unit: "cm",
    category: "dimension",
    sortOrder: 201,
    legacyFieldName: "waistCircumferenceCm",
    legacyColumnName: "waist_circumference_cm",
    isInteger: false,
  },
];

// ── Cardiovascular ──────────────────────────────────────────────────────────

const CARDIOVASCULAR: MeasurementTypeDefinition[] = [
  {
    id: "systolic_bp",
    displayName: "Systolic Blood Pressure",
    unit: "mmHg",
    category: "cardiovascular",
    sortOrder: 300,
    legacyFieldName: "systolicBp",
    legacyColumnName: "systolic_bp",
    isInteger: true,
  },
  {
    id: "diastolic_bp",
    displayName: "Diastolic Blood Pressure",
    unit: "mmHg",
    category: "cardiovascular",
    sortOrder: 301,
    legacyFieldName: "diastolicBp",
    legacyColumnName: "diastolic_bp",
    isInteger: true,
  },
  {
    id: "heart_pulse",
    displayName: "Heart Pulse",
    unit: "bpm",
    category: "cardiovascular",
    sortOrder: 302,
    legacyFieldName: "heartPulse",
    legacyColumnName: "heart_pulse",
    isInteger: true,
  },
];

// ── Temperature ─────────────────────────────────────────────────────────────

const TEMPERATURE: MeasurementTypeDefinition[] = [
  {
    id: "temperature",
    displayName: "Body Temperature",
    unit: "°C",
    category: "temperature",
    sortOrder: 400,
    legacyFieldName: "temperatureC",
    legacyColumnName: "temperature_c",
    isInteger: false,
  },
];

// ── Exported catalog ────────────────────────────────────────────────────────

/** Complete catalog of all body measurement types, sorted by category then sortOrder. */
export const MEASUREMENT_TYPES: readonly MeasurementTypeDefinition[] = [
  ...COMPOSITION,
  ...DIMENSIONS,
  ...CARDIOVASCULAR,
  ...TEMPERATURE,
] as const;

// ── Lookup indexes (built once at import time) ──────────────────────────────

const byId = new Map<string, MeasurementTypeDefinition>();
const byLegacyField = new Map<string, MeasurementTypeDefinition>();
const byLegacyColumn = new Map<string, MeasurementTypeDefinition>();

for (const measurementType of MEASUREMENT_TYPES) {
  byId.set(measurementType.id, measurementType);
  byLegacyField.set(measurementType.legacyFieldName, measurementType);
  byLegacyColumn.set(measurementType.legacyColumnName, measurementType);
}

/** Look up a measurement type by its stable id (e.g. 'weight'). */
export function getMeasurementTypeById(id: string): MeasurementTypeDefinition | null {
  return byId.get(id) ?? null;
}

/** Look up a measurement type by its legacy camelCase field name (e.g. 'weightKg'). */
export function getMeasurementTypeByLegacyField(
  fieldName: string,
): MeasurementTypeDefinition | null {
  return byLegacyField.get(fieldName) ?? null;
}

/** Look up a measurement type by its legacy snake_case column name (e.g. 'weight_kg'). */
export function getMeasurementTypeByLegacyColumn(
  columnName: string,
): MeasurementTypeDefinition | null {
  return byLegacyColumn.get(columnName) ?? null;
}

/**
 * Convert a flat object with legacy camelCase measurement fields
 * (e.g. { weightKg: 80.5, bodyFatPct: 18.2 }) into the normalized
 * measurements map (e.g. { weight: 80.5, body_fat_pct: 18.2 }).
 */
export function legacyFieldsToMeasurements(
  fields: Record<string, unknown>,
): Record<string, number> {
  const measurements: Record<string, number> = {};
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value == null || typeof value !== "number") continue;
    const definition = byLegacyField.get(fieldName);
    if (definition) {
      measurements[definition.id] = value;
    }
  }
  return measurements;
}
