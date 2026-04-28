import { z } from "zod";

// ============================================================
// Canonical nutrient field definitions — single source of truth
// ============================================================

/**
 * Metadata for each nutrient field: camelCase key, snake_case SQL column,
 * Drizzle column type, display label, and unit.
 */
export interface NutrientFieldDefinition {
  /** camelCase key used in TypeScript / Zod schemas */
  readonly key: string;
  /** snake_case column name in PostgreSQL */
  readonly column: string;
  /** 'integer' for calories, 'real' for everything else */
  readonly columnType: "integer" | "real";
  /** Human-readable label for UI display */
  readonly label: string;
  /** Measurement unit (g, mg, mcg, kcal) */
  readonly unit: string;
  /** Grouping category for display */
  readonly category:
    | "macro"
    | "fat_breakdown"
    | "other_macro"
    | "vitamin"
    | "mineral"
    | "fatty_acid"
    | "stimulant"
    | "hydration";
}

export const NUTRIENT_FIELDS: readonly NutrientFieldDefinition[] = [
  // Macronutrients
  {
    key: "calories",
    column: "calories",
    columnType: "integer",
    label: "Calories",
    unit: "kcal",
    category: "macro",
  },
  {
    key: "proteinG",
    column: "protein_g",
    columnType: "real",
    label: "Protein",
    unit: "g",
    category: "macro",
  },
  {
    key: "carbsG",
    column: "carbs_g",
    columnType: "real",
    label: "Carbs",
    unit: "g",
    category: "macro",
  },
  { key: "fatG", column: "fat_g", columnType: "real", label: "Fat", unit: "g", category: "macro" },
  // Fat breakdown
  {
    key: "saturatedFatG",
    column: "saturated_fat_g",
    columnType: "real",
    label: "Saturated Fat",
    unit: "g",
    category: "fat_breakdown",
  },
  {
    key: "polyunsaturatedFatG",
    column: "polyunsaturated_fat_g",
    columnType: "real",
    label: "Polyunsaturated Fat",
    unit: "g",
    category: "fat_breakdown",
  },
  {
    key: "monounsaturatedFatG",
    column: "monounsaturated_fat_g",
    columnType: "real",
    label: "Monounsaturated Fat",
    unit: "g",
    category: "fat_breakdown",
  },
  {
    key: "transFatG",
    column: "trans_fat_g",
    columnType: "real",
    label: "Trans Fat",
    unit: "g",
    category: "fat_breakdown",
  },
  // Other macros
  {
    key: "cholesterolMg",
    column: "cholesterol_mg",
    columnType: "real",
    label: "Cholesterol",
    unit: "mg",
    category: "other_macro",
  },
  {
    key: "sodiumMg",
    column: "sodium_mg",
    columnType: "real",
    label: "Sodium",
    unit: "mg",
    category: "other_macro",
  },
  {
    key: "potassiumMg",
    column: "potassium_mg",
    columnType: "real",
    label: "Potassium",
    unit: "mg",
    category: "other_macro",
  },
  {
    key: "fiberG",
    column: "fiber_g",
    columnType: "real",
    label: "Fiber",
    unit: "g",
    category: "other_macro",
  },
  {
    key: "sugarG",
    column: "sugar_g",
    columnType: "real",
    label: "Sugar",
    unit: "g",
    category: "other_macro",
  },
  // Vitamins
  {
    key: "vitaminAMcg",
    column: "vitamin_a_mcg",
    columnType: "real",
    label: "Vitamin A",
    unit: "mcg",
    category: "vitamin",
  },
  {
    key: "vitaminCMg",
    column: "vitamin_c_mg",
    columnType: "real",
    label: "Vitamin C",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminDMcg",
    column: "vitamin_d_mcg",
    columnType: "real",
    label: "Vitamin D",
    unit: "mcg",
    category: "vitamin",
  },
  {
    key: "vitaminEMg",
    column: "vitamin_e_mg",
    columnType: "real",
    label: "Vitamin E",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminKMcg",
    column: "vitamin_k_mcg",
    columnType: "real",
    label: "Vitamin K",
    unit: "mcg",
    category: "vitamin",
  },
  {
    key: "vitaminB1Mg",
    column: "vitamin_b1_mg",
    columnType: "real",
    label: "B1 (Thiamin)",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminB2Mg",
    column: "vitamin_b2_mg",
    columnType: "real",
    label: "B2 (Riboflavin)",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminB3Mg",
    column: "vitamin_b3_mg",
    columnType: "real",
    label: "B3 (Niacin)",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminB5Mg",
    column: "vitamin_b5_mg",
    columnType: "real",
    label: "B5 (Pantothenic)",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminB6Mg",
    column: "vitamin_b6_mg",
    columnType: "real",
    label: "B6",
    unit: "mg",
    category: "vitamin",
  },
  {
    key: "vitaminB7Mcg",
    column: "vitamin_b7_mcg",
    columnType: "real",
    label: "B7 (Biotin)",
    unit: "mcg",
    category: "vitamin",
  },
  {
    key: "vitaminB9Mcg",
    column: "vitamin_b9_mcg",
    columnType: "real",
    label: "B9 (Folate)",
    unit: "mcg",
    category: "vitamin",
  },
  {
    key: "vitaminB12Mcg",
    column: "vitamin_b12_mcg",
    columnType: "real",
    label: "B12",
    unit: "mcg",
    category: "vitamin",
  },
  // Minerals
  {
    key: "calciumMg",
    column: "calcium_mg",
    columnType: "real",
    label: "Calcium",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "ironMg",
    column: "iron_mg",
    columnType: "real",
    label: "Iron",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "magnesiumMg",
    column: "magnesium_mg",
    columnType: "real",
    label: "Magnesium",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "zincMg",
    column: "zinc_mg",
    columnType: "real",
    label: "Zinc",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "seleniumMcg",
    column: "selenium_mcg",
    columnType: "real",
    label: "Selenium",
    unit: "mcg",
    category: "mineral",
  },
  {
    key: "copperMg",
    column: "copper_mg",
    columnType: "real",
    label: "Copper",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "manganeseMg",
    column: "manganese_mg",
    columnType: "real",
    label: "Manganese",
    unit: "mg",
    category: "mineral",
  },
  {
    key: "chromiumMcg",
    column: "chromium_mcg",
    columnType: "real",
    label: "Chromium",
    unit: "mcg",
    category: "mineral",
  },
  {
    key: "iodineMcg",
    column: "iodine_mcg",
    columnType: "real",
    label: "Iodine",
    unit: "mcg",
    category: "mineral",
  },
  // Fatty acids
  {
    key: "omega3Mg",
    column: "omega3_mg",
    columnType: "real",
    label: "Omega-3",
    unit: "mg",
    category: "fatty_acid",
  },
  {
    key: "omega6Mg",
    column: "omega6_mg",
    columnType: "real",
    label: "Omega-6",
    unit: "mg",
    category: "fatty_acid",
  },
  {
    key: "caffeineMg",
    column: "caffeine_mg",
    columnType: "real",
    label: "Caffeine",
    unit: "mg",
    category: "stimulant",
  },
  {
    key: "waterMl",
    column: "water_ml",
    columnType: "real",
    label: "Water",
    unit: "ml",
    category: "hydration",
  },
] as const;

/** camelCase nutrient keys (e.g., 'calories', 'proteinG', 'vitaminAMcg') */
export const NUTRIENT_KEYS = NUTRIENT_FIELDS.map((f) => f.key);

/** Map of camelCase key → snake_case SQL column name */
export const NUTRIENT_COLUMN_MAP: Record<string, string> = Object.fromEntries(
  NUTRIENT_FIELDS.map((f) => [f.key, f.column]),
);

/** Map of snake_case SQL column name → camelCase key */
export const NUTRIENT_KEY_MAP: Record<string, string> = Object.fromEntries(
  NUTRIENT_FIELDS.map((f) => [f.column, f.key]),
);

/** Map of legacy camelCase key → canonical fitness.nutrient.id */
export const NUTRIENT_ID_MAP: Record<string, string> = {
  calories: "calories",
  proteinG: "protein",
  carbsG: "carbohydrate",
  fatG: "fat",
  saturatedFatG: "saturated_fat",
  polyunsaturatedFatG: "polyunsaturated_fat",
  monounsaturatedFatG: "monounsaturated_fat",
  transFatG: "trans_fat",
  cholesterolMg: "cholesterol",
  sodiumMg: "sodium",
  potassiumMg: "potassium",
  fiberG: "fiber",
  sugarG: "sugar",
  vitaminAMcg: "vitamin_a",
  vitaminCMg: "vitamin_c",
  vitaminDMcg: "vitamin_d",
  vitaminEMg: "vitamin_e",
  vitaminKMcg: "vitamin_k",
  vitaminB1Mg: "vitamin_b1",
  vitaminB2Mg: "vitamin_b2",
  vitaminB3Mg: "vitamin_b3",
  vitaminB5Mg: "vitamin_b5",
  vitaminB6Mg: "vitamin_b6",
  vitaminB7Mcg: "vitamin_b7",
  vitaminB9Mcg: "vitamin_b9",
  vitaminB12Mcg: "vitamin_b12",
  calciumMg: "calcium",
  ironMg: "iron",
  magnesiumMg: "magnesium",
  zincMg: "zinc",
  seleniumMcg: "selenium",
  copperMg: "copper",
  manganeseMg: "manganese",
  chromiumMcg: "chromium",
  iodineMcg: "iodine",
  omega3Mg: "omega_3",
  omega6Mg: "omega_6",
  caffeineMg: "caffeine",
  waterMl: "water",
};

/** Map of canonical fitness.nutrient.id → legacy camelCase key */
export const NUTRIENT_FIELD_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(NUTRIENT_ID_MAP).map(([key, nutrientId]) => [nutrientId, key]),
);

// ============================================================
// Zod schemas
// ============================================================

/** Zod schema for nutrient fields in camelCase (API input/output). All fields nullable/optional. */
export const nutrientFieldsSchema = z.object({
  calories: z.number().int().nonnegative().nullish(),
  proteinG: z.number().nonnegative().nullish(),
  carbsG: z.number().nonnegative().nullish(),
  fatG: z.number().nonnegative().nullish(),
  saturatedFatG: z.number().nonnegative().nullish(),
  polyunsaturatedFatG: z.number().nonnegative().nullish(),
  monounsaturatedFatG: z.number().nonnegative().nullish(),
  transFatG: z.number().nonnegative().nullish(),
  cholesterolMg: z.number().nonnegative().nullish(),
  sodiumMg: z.number().nonnegative().nullish(),
  potassiumMg: z.number().nonnegative().nullish(),
  fiberG: z.number().nonnegative().nullish(),
  sugarG: z.number().nonnegative().nullish(),
  vitaminAMcg: z.number().nonnegative().nullish(),
  vitaminCMg: z.number().nonnegative().nullish(),
  vitaminDMcg: z.number().nonnegative().nullish(),
  vitaminEMg: z.number().nonnegative().nullish(),
  vitaminKMcg: z.number().nonnegative().nullish(),
  vitaminB1Mg: z.number().nonnegative().nullish(),
  vitaminB2Mg: z.number().nonnegative().nullish(),
  vitaminB3Mg: z.number().nonnegative().nullish(),
  vitaminB5Mg: z.number().nonnegative().nullish(),
  vitaminB6Mg: z.number().nonnegative().nullish(),
  vitaminB7Mcg: z.number().nonnegative().nullish(),
  vitaminB9Mcg: z.number().nonnegative().nullish(),
  vitaminB12Mcg: z.number().nonnegative().nullish(),
  calciumMg: z.number().nonnegative().nullish(),
  ironMg: z.number().nonnegative().nullish(),
  magnesiumMg: z.number().nonnegative().nullish(),
  zincMg: z.number().nonnegative().nullish(),
  seleniumMcg: z.number().nonnegative().nullish(),
  copperMg: z.number().nonnegative().nullish(),
  manganeseMg: z.number().nonnegative().nullish(),
  chromiumMcg: z.number().nonnegative().nullish(),
  iodineMcg: z.number().nonnegative().nullish(),
  omega3Mg: z.number().nonnegative().nullish(),
  omega6Mg: z.number().nonnegative().nullish(),
  caffeineMg: z.number().nonnegative().nullish(),
  waterMl: z.number().nonnegative().nullish(),
});

const nullableNumberFromRow = z.preprocess(
  (value) => (value === undefined ? null : value),
  z.coerce.number().nullable(),
);

/** Zod schema for nutrient fields in snake_case (DB row parsing). All fields nullable with coerce. */
export const nutrientRowSchema = z.object({
  calories: nullableNumberFromRow,
  protein_g: nullableNumberFromRow,
  carbs_g: nullableNumberFromRow,
  fat_g: nullableNumberFromRow,
  saturated_fat_g: nullableNumberFromRow,
  polyunsaturated_fat_g: nullableNumberFromRow,
  monounsaturated_fat_g: nullableNumberFromRow,
  trans_fat_g: nullableNumberFromRow,
  cholesterol_mg: nullableNumberFromRow,
  sodium_mg: nullableNumberFromRow,
  potassium_mg: nullableNumberFromRow,
  fiber_g: nullableNumberFromRow,
  sugar_g: nullableNumberFromRow,
  vitamin_a_mcg: nullableNumberFromRow,
  vitamin_c_mg: nullableNumberFromRow,
  vitamin_d_mcg: nullableNumberFromRow,
  vitamin_e_mg: nullableNumberFromRow,
  vitamin_k_mcg: nullableNumberFromRow,
  vitamin_b1_mg: nullableNumberFromRow,
  vitamin_b2_mg: nullableNumberFromRow,
  vitamin_b3_mg: nullableNumberFromRow,
  vitamin_b5_mg: nullableNumberFromRow,
  vitamin_b6_mg: nullableNumberFromRow,
  vitamin_b7_mcg: nullableNumberFromRow,
  vitamin_b9_mcg: nullableNumberFromRow,
  vitamin_b12_mcg: nullableNumberFromRow,
  calcium_mg: nullableNumberFromRow,
  iron_mg: nullableNumberFromRow,
  magnesium_mg: nullableNumberFromRow,
  zinc_mg: nullableNumberFromRow,
  selenium_mcg: nullableNumberFromRow,
  copper_mg: nullableNumberFromRow,
  manganese_mg: nullableNumberFromRow,
  chromium_mcg: nullableNumberFromRow,
  iodine_mcg: nullableNumberFromRow,
  omega3_mg: nullableNumberFromRow,
  omega6_mg: nullableNumberFromRow,
  caffeine_mg: nullableNumberFromRow,
  water_ml: nullableNumberFromRow,
});

/** Type for nutrient values in camelCase */
export type NutrientValues = z.infer<typeof nutrientFieldsSchema>;

/**
 * Extract nutrient values from an object with camelCase keys.
 * Returns a record with only the nutrient keys, defaulting missing values to null.
 */
export function extractNutrientValues(
  source: Record<string, unknown>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const field of NUTRIENT_FIELDS) {
    const value = source[field.key];
    result[field.key] = typeof value === "number" ? value : null;
  }
  return result;
}

export interface NutrientAmountEntry {
  readonly nutrientId: string;
  readonly amount: number;
}

export interface NullableNutrientAmountEntry {
  readonly nutrientId: string;
  readonly amount: number | null;
}

/** Convert legacy camelCase nutrient fields to canonical nutrient amount rows. */
export function nutrientAmountEntriesFromLegacyFields(
  source: Record<string, unknown>,
): NutrientAmountEntry[] {
  const entries: NutrientAmountEntry[] = [];
  for (const [legacyFieldName, nutrientId] of Object.entries(NUTRIENT_ID_MAP)) {
    const value = source[legacyFieldName];
    if (typeof value === "number") {
      entries.push({ nutrientId, amount: value });
    }
  }
  return entries;
}

/** Convert legacy camelCase nutrient updates to canonical rows, preserving null deletes. */
export function nullableNutrientAmountEntriesFromLegacyFields(
  source: Record<string, unknown>,
): NullableNutrientAmountEntry[] {
  const entries: NullableNutrientAmountEntry[] = [];
  for (const [legacyFieldName, nutrientId] of Object.entries(NUTRIENT_ID_MAP)) {
    const value = source[legacyFieldName];
    if (typeof value === "number" || value === null) {
      entries.push({ nutrientId, amount: value });
    }
  }
  return entries;
}

/**
 * Convert camelCase nutrient values to snake_case column names for SQL.
 */
export function nutrientValuesToColumns(
  source: Record<string, unknown>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const field of NUTRIENT_FIELDS) {
    const value = source[field.key];
    result[field.column] = typeof value === "number" ? value : null;
  }
  return result;
}

/**
 * Convert snake_case DB row nutrient values to camelCase keys.
 */
export function nutrientColumnsToValues(
  row: Record<string, unknown>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const field of NUTRIENT_FIELDS) {
    const value = row[field.column];
    result[field.key] = typeof value === "number" ? value : null;
  }
  return result;
}
