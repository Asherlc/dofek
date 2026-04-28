/**
 * Canonical nutrient catalog — the single source of truth for all micronutrient
 * metadata. Consolidates definitions previously scattered across ~6 files
 * (RDA tables, display labels, OFF key mappings, field→column maps).
 *
 * Nutrients are stored as row-based amounts in the database. Legacy field names
 * exist only at API/provider boundaries.
 */

export type NutrientCategory =
  | "macro"
  | "fat_breakdown"
  | "other_macro"
  | "vitamin"
  | "mineral"
  | "fatty_acid"
  | "stimulant";

export interface NutrientDefinition {
  /** Stable identifier, used as DB primary key. e.g. 'vitamin_a', 'calcium' */
  readonly id: string;
  /** Human-readable name. e.g. 'Vitamin A', 'Calcium' */
  readonly displayName: string;
  /** Unit of measurement. e.g. 'mcg', 'mg', 'g' */
  readonly unit: string;
  /** Grouping category for UI sections */
  readonly category: NutrientCategory;
  /** NIH Recommended Daily Allowance for adult males 19-50 (null if no established RDA) */
  readonly rda: number | null;
  /** Sort order within category for consistent UI rendering */
  readonly sortOrder: number;
  /** Open Food Facts nutriment key (null if OFF doesn't track this nutrient) */
  readonly openFoodFactsKey: string | null;
  /** Multiplier applied to OFF values (e.g. 1000 for sodium grams → mg) */
  readonly conversionFactor: number;
  /** Legacy camelCase field name on FoodDatabaseResult / food_entry schema. e.g. 'vitaminAMcg' */
  readonly legacyFieldName: string;
  /** Legacy snake_case DB column name. e.g. 'vitamin_a_mcg' */
  readonly legacyColumnName: string;
}

// ── Macros ─────────────────────────────────────────────────────────────────

const MACROS: NutrientDefinition[] = [
  {
    id: "calories",
    displayName: "Calories",
    unit: "kcal",
    category: "macro",
    rda: null,
    sortOrder: 1,
    openFoodFactsKey: "energy-kcal",
    conversionFactor: 1,
    legacyFieldName: "calories",
    legacyColumnName: "calories",
  },
  {
    id: "protein",
    displayName: "Protein",
    unit: "g",
    category: "macro",
    rda: null,
    sortOrder: 2,
    openFoodFactsKey: "proteins",
    conversionFactor: 1,
    legacyFieldName: "proteinG",
    legacyColumnName: "protein_g",
  },
  {
    id: "carbohydrate",
    displayName: "Carbohydrates",
    unit: "g",
    category: "macro",
    rda: null,
    sortOrder: 3,
    openFoodFactsKey: "carbohydrates",
    conversionFactor: 1,
    legacyFieldName: "carbsG",
    legacyColumnName: "carbs_g",
  },
  {
    id: "fat",
    displayName: "Fat",
    unit: "g",
    category: "macro",
    rda: null,
    sortOrder: 4,
    openFoodFactsKey: "fat",
    conversionFactor: 1,
    legacyFieldName: "fatG",
    legacyColumnName: "fat_g",
  },
  {
    id: "fiber",
    displayName: "Fiber",
    unit: "g",
    category: "macro",
    rda: 38,
    sortOrder: 5,
    openFoodFactsKey: "fiber",
    conversionFactor: 1,
    legacyFieldName: "fiberG",
    legacyColumnName: "fiber_g",
  },
];

// ── Fat breakdown ───────────────────────────────────────────────────────────

const FAT_BREAKDOWN: NutrientDefinition[] = [
  {
    id: "saturated_fat",
    displayName: "Saturated Fat",
    unit: "g",
    category: "fat_breakdown",
    rda: null,
    sortOrder: 100,
    openFoodFactsKey: "saturated-fat",
    conversionFactor: 1,
    legacyFieldName: "saturatedFatG",
    legacyColumnName: "saturated_fat_g",
  },
  {
    id: "polyunsaturated_fat",
    displayName: "Polyunsaturated Fat",
    unit: "g",
    category: "fat_breakdown",
    rda: null,
    sortOrder: 101,
    openFoodFactsKey: "polyunsaturated-fat",
    conversionFactor: 1,
    legacyFieldName: "polyunsaturatedFatG",
    legacyColumnName: "polyunsaturated_fat_g",
  },
  {
    id: "monounsaturated_fat",
    displayName: "Monounsaturated Fat",
    unit: "g",
    category: "fat_breakdown",
    rda: null,
    sortOrder: 102,
    openFoodFactsKey: "monounsaturated-fat",
    conversionFactor: 1,
    legacyFieldName: "monounsaturatedFatG",
    legacyColumnName: "monounsaturated_fat_g",
  },
  {
    id: "trans_fat",
    displayName: "Trans Fat",
    unit: "g",
    category: "fat_breakdown",
    rda: null,
    sortOrder: 103,
    openFoodFactsKey: "trans-fat",
    conversionFactor: 1,
    legacyFieldName: "transFatG",
    legacyColumnName: "trans_fat_g",
  },
];

// ── Other macros (not main macros, but macro-adjacent) ──────────────────────

const OTHER_MACROS: NutrientDefinition[] = [
  {
    id: "cholesterol",
    displayName: "Cholesterol",
    unit: "mg",
    category: "other_macro",
    rda: null,
    sortOrder: 200,
    openFoodFactsKey: "cholesterol",
    conversionFactor: 1,
    legacyFieldName: "cholesterolMg",
    legacyColumnName: "cholesterol_mg",
  },
  {
    id: "sodium",
    displayName: "Sodium",
    unit: "mg",
    category: "other_macro",
    rda: 2300,
    sortOrder: 201,
    openFoodFactsKey: "sodium",
    conversionFactor: 1000, // OFF stores in grams
    legacyFieldName: "sodiumMg",
    legacyColumnName: "sodium_mg",
  },
  {
    id: "potassium",
    displayName: "Potassium",
    unit: "mg",
    category: "other_macro",
    rda: 3400,
    sortOrder: 202,
    openFoodFactsKey: "potassium",
    conversionFactor: 1,
    legacyFieldName: "potassiumMg",
    legacyColumnName: "potassium_mg",
  },
  {
    id: "sugar",
    displayName: "Sugar",
    unit: "g",
    category: "other_macro",
    rda: null,
    sortOrder: 203,
    openFoodFactsKey: "sugars",
    conversionFactor: 1,
    legacyFieldName: "sugarG",
    legacyColumnName: "sugar_g",
  },
];

// ── Vitamins ────────────────────────────────────────────────────────────────

const VITAMINS: NutrientDefinition[] = [
  {
    id: "vitamin_a",
    displayName: "Vitamin A",
    unit: "mcg",
    category: "vitamin",
    rda: 900,
    sortOrder: 300,
    openFoodFactsKey: "vitamin-a",
    conversionFactor: 1,
    legacyFieldName: "vitaminAMcg",
    legacyColumnName: "vitamin_a_mcg",
  },
  {
    id: "vitamin_c",
    displayName: "Vitamin C",
    unit: "mg",
    category: "vitamin",
    rda: 90,
    sortOrder: 301,
    openFoodFactsKey: "vitamin-c",
    conversionFactor: 1,
    legacyFieldName: "vitaminCMg",
    legacyColumnName: "vitamin_c_mg",
  },
  {
    id: "vitamin_d",
    displayName: "Vitamin D",
    unit: "mcg",
    category: "vitamin",
    rda: 15,
    sortOrder: 302,
    openFoodFactsKey: "vitamin-d",
    conversionFactor: 1,
    legacyFieldName: "vitaminDMcg",
    legacyColumnName: "vitamin_d_mcg",
  },
  {
    id: "vitamin_e",
    displayName: "Vitamin E",
    unit: "mg",
    category: "vitamin",
    rda: 15,
    sortOrder: 303,
    openFoodFactsKey: "vitamin-e",
    conversionFactor: 1,
    legacyFieldName: "vitaminEMg",
    legacyColumnName: "vitamin_e_mg",
  },
  {
    id: "vitamin_k",
    displayName: "Vitamin K",
    unit: "mcg",
    category: "vitamin",
    rda: 120,
    sortOrder: 304,
    openFoodFactsKey: "vitamin-k",
    conversionFactor: 1,
    legacyFieldName: "vitaminKMcg",
    legacyColumnName: "vitamin_k_mcg",
  },
  {
    id: "vitamin_b1",
    displayName: "Vitamin B1 (Thiamin)",
    unit: "mg",
    category: "vitamin",
    rda: 1.2,
    sortOrder: 305,
    openFoodFactsKey: "vitamin-b1",
    conversionFactor: 1,
    legacyFieldName: "vitaminB1Mg",
    legacyColumnName: "vitamin_b1_mg",
  },
  {
    id: "vitamin_b2",
    displayName: "Vitamin B2 (Riboflavin)",
    unit: "mg",
    category: "vitamin",
    rda: 1.3,
    sortOrder: 306,
    openFoodFactsKey: "vitamin-b2",
    conversionFactor: 1,
    legacyFieldName: "vitaminB2Mg",
    legacyColumnName: "vitamin_b2_mg",
  },
  {
    id: "vitamin_b3",
    displayName: "Vitamin B3 (Niacin)",
    unit: "mg",
    category: "vitamin",
    rda: 16,
    sortOrder: 307,
    openFoodFactsKey: "vitamin-pp", // OFF uses "vitamin-pp" for niacin
    conversionFactor: 1,
    legacyFieldName: "vitaminB3Mg",
    legacyColumnName: "vitamin_b3_mg",
  },
  {
    id: "vitamin_b5",
    displayName: "Vitamin B5 (Pantothenic Acid)",
    unit: "mg",
    category: "vitamin",
    rda: 5,
    sortOrder: 308,
    openFoodFactsKey: "pantothenic-acid",
    conversionFactor: 1,
    legacyFieldName: "vitaminB5Mg",
    legacyColumnName: "vitamin_b5_mg",
  },
  {
    id: "vitamin_b6",
    displayName: "Vitamin B6",
    unit: "mg",
    category: "vitamin",
    rda: 1.3,
    sortOrder: 309,
    openFoodFactsKey: "vitamin-b6",
    conversionFactor: 1,
    legacyFieldName: "vitaminB6Mg",
    legacyColumnName: "vitamin_b6_mg",
  },
  {
    id: "vitamin_b7",
    displayName: "Vitamin B7 (Biotin)",
    unit: "mcg",
    category: "vitamin",
    rda: 30,
    sortOrder: 310,
    openFoodFactsKey: "biotin",
    conversionFactor: 1,
    legacyFieldName: "vitaminB7Mcg",
    legacyColumnName: "vitamin_b7_mcg",
  },
  {
    id: "vitamin_b9",
    displayName: "Vitamin B9 (Folate)",
    unit: "mcg",
    category: "vitamin",
    rda: 400,
    sortOrder: 311,
    openFoodFactsKey: "vitamin-b9",
    conversionFactor: 1,
    legacyFieldName: "vitaminB9Mcg",
    legacyColumnName: "vitamin_b9_mcg",
  },
  {
    id: "vitamin_b12",
    displayName: "Vitamin B12",
    unit: "mcg",
    category: "vitamin",
    rda: 2.4,
    sortOrder: 312,
    openFoodFactsKey: "vitamin-b12",
    conversionFactor: 1,
    legacyFieldName: "vitaminB12Mcg",
    legacyColumnName: "vitamin_b12_mcg",
  },
];

// ── Minerals ────────────────────────────────────────────────────────────────

const MINERALS: NutrientDefinition[] = [
  {
    id: "calcium",
    displayName: "Calcium",
    unit: "mg",
    category: "mineral",
    rda: 1000,
    sortOrder: 400,
    openFoodFactsKey: "calcium",
    conversionFactor: 1,
    legacyFieldName: "calciumMg",
    legacyColumnName: "calcium_mg",
  },
  {
    id: "iron",
    displayName: "Iron",
    unit: "mg",
    category: "mineral",
    rda: 8,
    sortOrder: 401,
    openFoodFactsKey: "iron",
    conversionFactor: 1,
    legacyFieldName: "ironMg",
    legacyColumnName: "iron_mg",
  },
  {
    id: "magnesium",
    displayName: "Magnesium",
    unit: "mg",
    category: "mineral",
    rda: 420,
    sortOrder: 402,
    openFoodFactsKey: "magnesium",
    conversionFactor: 1,
    legacyFieldName: "magnesiumMg",
    legacyColumnName: "magnesium_mg",
  },
  {
    id: "zinc",
    displayName: "Zinc",
    unit: "mg",
    category: "mineral",
    rda: 11,
    sortOrder: 403,
    openFoodFactsKey: "zinc",
    conversionFactor: 1,
    legacyFieldName: "zincMg",
    legacyColumnName: "zinc_mg",
  },
  {
    id: "selenium",
    displayName: "Selenium",
    unit: "mcg",
    category: "mineral",
    rda: 55,
    sortOrder: 404,
    openFoodFactsKey: "selenium",
    conversionFactor: 1,
    legacyFieldName: "seleniumMcg",
    legacyColumnName: "selenium_mcg",
  },
  {
    id: "copper",
    displayName: "Copper",
    unit: "mg",
    category: "mineral",
    rda: 0.9,
    sortOrder: 405,
    openFoodFactsKey: "copper",
    conversionFactor: 1,
    legacyFieldName: "copperMg",
    legacyColumnName: "copper_mg",
  },
  {
    id: "manganese",
    displayName: "Manganese",
    unit: "mg",
    category: "mineral",
    rda: 2.3,
    sortOrder: 406,
    openFoodFactsKey: "manganese",
    conversionFactor: 1,
    legacyFieldName: "manganeseMg",
    legacyColumnName: "manganese_mg",
  },
  {
    id: "chromium",
    displayName: "Chromium",
    unit: "mcg",
    category: "mineral",
    rda: 35,
    sortOrder: 407,
    openFoodFactsKey: "chromium",
    conversionFactor: 1,
    legacyFieldName: "chromiumMcg",
    legacyColumnName: "chromium_mcg",
  },
  {
    id: "iodine",
    displayName: "Iodine",
    unit: "mcg",
    category: "mineral",
    rda: 150,
    sortOrder: 408,
    openFoodFactsKey: "iodine",
    conversionFactor: 1,
    legacyFieldName: "iodineMcg",
    legacyColumnName: "iodine_mcg",
  },
  {
    id: "phosphorus",
    displayName: "Phosphorus",
    unit: "mg",
    category: "mineral",
    rda: 700,
    sortOrder: 409,
    openFoodFactsKey: "phosphorus",
    conversionFactor: 1,
    legacyFieldName: "phosphorusMg",
    legacyColumnName: "phosphorus_mg",
  },
  {
    id: "molybdenum",
    displayName: "Molybdenum",
    unit: "mcg",
    category: "mineral",
    rda: 45,
    sortOrder: 410,
    openFoodFactsKey: "molybdenum",
    conversionFactor: 1,
    legacyFieldName: "molybdenumMcg",
    legacyColumnName: "molybdenum_mcg",
  },
  {
    id: "chloride",
    displayName: "Chloride",
    unit: "mg",
    category: "mineral",
    rda: 2300,
    sortOrder: 411,
    openFoodFactsKey: "chloride",
    conversionFactor: 1,
    legacyFieldName: "chlorideMg",
    legacyColumnName: "chloride_mg",
  },
  {
    id: "fluoride",
    displayName: "Fluoride",
    unit: "mg",
    category: "mineral",
    rda: 4,
    sortOrder: 412,
    openFoodFactsKey: "fluoride",
    conversionFactor: 1,
    legacyFieldName: "fluorideMg",
    legacyColumnName: "fluoride_mg",
  },
  {
    id: "choline",
    displayName: "Choline",
    unit: "mg",
    category: "mineral",
    rda: 550,
    sortOrder: 413,
    openFoodFactsKey: "choline",
    conversionFactor: 1,
    legacyFieldName: "cholineMg",
    legacyColumnName: "choline_mg",
  },
];

// ── Fatty acids ─────────────────────────────────────────────────────────────

const FATTY_ACIDS: NutrientDefinition[] = [
  {
    id: "omega_3",
    displayName: "Omega-3",
    unit: "mg",
    category: "fatty_acid",
    rda: null,
    sortOrder: 500,
    openFoodFactsKey: "omega-3-fat",
    conversionFactor: 1000, // OFF stores in grams
    legacyFieldName: "omega3Mg",
    legacyColumnName: "omega3_mg",
  },
  {
    id: "omega_6",
    displayName: "Omega-6",
    unit: "mg",
    category: "fatty_acid",
    rda: null,
    sortOrder: 501,
    openFoodFactsKey: "omega-6-fat",
    conversionFactor: 1000, // OFF stores in grams
    legacyFieldName: "omega6Mg",
    legacyColumnName: "omega6_mg",
  },
];

// ── Stimulants ─────────────────────────────────────────────────────────────

const STIMULANTS: NutrientDefinition[] = [
  {
    id: "caffeine",
    displayName: "Caffeine",
    unit: "mg",
    category: "stimulant",
    rda: null,
    sortOrder: 600,
    openFoodFactsKey: "caffeine",
    conversionFactor: 1,
    legacyFieldName: "caffeineMg",
    legacyColumnName: "caffeine_mg",
  },
];

// ── Exported catalog ────────────────────────────────────────────────────────

/** Complete catalog of all tracked micronutrients, sorted by category then sortOrder. */
export const NUTRIENTS: readonly NutrientDefinition[] = [
  ...MACROS,
  ...FAT_BREAKDOWN,
  ...OTHER_MACROS,
  ...VITAMINS,
  ...MINERALS,
  ...FATTY_ACIDS,
  ...STIMULANTS,
] as const;

// ── Lookup indexes (built once at import time) ──────────────────────────────

const byId = new Map<string, NutrientDefinition>();
const byLegacyField = new Map<string, NutrientDefinition>();

for (const nutrient of NUTRIENTS) {
  byId.set(nutrient.id, nutrient);
  byLegacyField.set(nutrient.legacyFieldName, nutrient);
}

/** Look up a nutrient by its stable id (e.g. 'vitamin_a'). */
export function getNutrientById(id: string): NutrientDefinition | null {
  return byId.get(id) ?? null;
}

/** Look up a nutrient by its legacy camelCase field name (e.g. 'vitaminAMcg'). */
export function getNutrientByLegacyField(fieldName: string): NutrientDefinition | null {
  return byLegacyField.get(fieldName) ?? null;
}

/** Get all nutrients in a given category, sorted by sortOrder. */
export function getNutrientsByCategory(category: NutrientCategory): NutrientDefinition[] {
  return NUTRIENTS.filter((nutrient) => nutrient.category === category).sort(
    (first, second) => first.sortOrder - second.sortOrder,
  );
}

/**
 * Convert a flat object with legacy camelCase nutrient fields (e.g. { vitaminAMcg: 150, calciumMg: 200 })
 * into the normalized nutrients map (e.g. { vitamin_a: 150, calcium: 200 }).
 * Skips null/undefined values. Useful for migrating AI results, provider data, etc.
 */
export function legacyFieldsToNutrients(fields: Record<string, unknown>): Record<string, number> {
  const nutrients: Record<string, number> = {};
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value == null || typeof value !== "number") continue;
    const definition = byLegacyField.get(fieldName);
    if (definition) {
      nutrients[definition.id] = value;
    }
  }
  return nutrients;
}
