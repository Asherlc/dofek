import { integer, real } from "drizzle-orm/pg-core";
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
    | "fatty_acid";
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

// ============================================================
// Drizzle column builders
// ============================================================

/**
 * Drizzle column definitions for all 39 nutrient fields.
 * Spread into a `pgSchema.table()` definition.
 */
export function buildNutrientColumns() {
  return {
    // Macronutrients
    calories: integer("calories"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    // Fat breakdown
    saturatedFatG: real("saturated_fat_g"),
    polyunsaturatedFatG: real("polyunsaturated_fat_g"),
    monounsaturatedFatG: real("monounsaturated_fat_g"),
    transFatG: real("trans_fat_g"),
    // Other macros
    cholesterolMg: real("cholesterol_mg"),
    sodiumMg: real("sodium_mg"),
    potassiumMg: real("potassium_mg"),
    fiberG: real("fiber_g"),
    sugarG: real("sugar_g"),
    // Vitamins
    vitaminAMcg: real("vitamin_a_mcg"),
    vitaminCMg: real("vitamin_c_mg"),
    vitaminDMcg: real("vitamin_d_mcg"),
    vitaminEMg: real("vitamin_e_mg"),
    vitaminKMcg: real("vitamin_k_mcg"),
    vitaminB1Mg: real("vitamin_b1_mg"),
    vitaminB2Mg: real("vitamin_b2_mg"),
    vitaminB3Mg: real("vitamin_b3_mg"),
    vitaminB5Mg: real("vitamin_b5_mg"),
    vitaminB6Mg: real("vitamin_b6_mg"),
    vitaminB7Mcg: real("vitamin_b7_mcg"),
    vitaminB9Mcg: real("vitamin_b9_mcg"),
    vitaminB12Mcg: real("vitamin_b12_mcg"),
    // Minerals
    calciumMg: real("calcium_mg"),
    ironMg: real("iron_mg"),
    magnesiumMg: real("magnesium_mg"),
    zincMg: real("zinc_mg"),
    seleniumMcg: real("selenium_mcg"),
    copperMg: real("copper_mg"),
    manganeseMg: real("manganese_mg"),
    chromiumMcg: real("chromium_mcg"),
    iodineMcg: real("iodine_mcg"),
    // Fatty acids
    omega3Mg: real("omega3_mg"),
    omega6Mg: real("omega6_mg"),
  };
}

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
});

/** Zod schema for nutrient fields in snake_case (DB row parsing). All fields nullable with coerce. */
export const nutrientRowSchema = z.object({
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  carbs_g: z.coerce.number().nullable(),
  fat_g: z.coerce.number().nullable(),
  saturated_fat_g: z.coerce.number().nullable(),
  polyunsaturated_fat_g: z.coerce.number().nullable(),
  monounsaturated_fat_g: z.coerce.number().nullable(),
  trans_fat_g: z.coerce.number().nullable(),
  cholesterol_mg: z.coerce.number().nullable(),
  sodium_mg: z.coerce.number().nullable(),
  potassium_mg: z.coerce.number().nullable(),
  fiber_g: z.coerce.number().nullable(),
  sugar_g: z.coerce.number().nullable(),
  vitamin_a_mcg: z.coerce.number().nullable(),
  vitamin_c_mg: z.coerce.number().nullable(),
  vitamin_d_mcg: z.coerce.number().nullable(),
  vitamin_e_mg: z.coerce.number().nullable(),
  vitamin_k_mcg: z.coerce.number().nullable(),
  vitamin_b1_mg: z.coerce.number().nullable(),
  vitamin_b2_mg: z.coerce.number().nullable(),
  vitamin_b3_mg: z.coerce.number().nullable(),
  vitamin_b5_mg: z.coerce.number().nullable(),
  vitamin_b6_mg: z.coerce.number().nullable(),
  vitamin_b7_mcg: z.coerce.number().nullable(),
  vitamin_b9_mcg: z.coerce.number().nullable(),
  vitamin_b12_mcg: z.coerce.number().nullable(),
  calcium_mg: z.coerce.number().nullable(),
  iron_mg: z.coerce.number().nullable(),
  magnesium_mg: z.coerce.number().nullable(),
  zinc_mg: z.coerce.number().nullable(),
  selenium_mcg: z.coerce.number().nullable(),
  copper_mg: z.coerce.number().nullable(),
  manganese_mg: z.coerce.number().nullable(),
  chromium_mcg: z.coerce.number().nullable(),
  iodine_mcg: z.coerce.number().nullable(),
  omega3_mg: z.coerce.number().nullable(),
  omega6_mg: z.coerce.number().nullable(),
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

/** SQL column names for all nutrient fields, comma-separated (for raw SQL SELECT/INSERT) */
export const NUTRIENT_SQL_COLUMNS = NUTRIENT_FIELDS.map((f) => f.column).join(", ");
