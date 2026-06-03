import { z } from "zod";

// ============================================================
// FatSecret API types
// ============================================================

export interface FatSecretFoodEntry {
  food_entry_id: string;
  food_entry_name: string;
  food_entry_description: string;
  food_id: string;
  serving_id: string;
  number_of_units: string;
  meal: string;
  date_int: string;
  calories: string;
  carbohydrate: string;
  protein: string;
  fat: string;
  saturated_fat?: string;
  polyunsaturated_fat?: string;
  monounsaturated_fat?: string;
  cholesterol?: string;
  sodium?: string;
  potassium?: string;
  fiber?: string;
  sugar?: string;
  vitamin_a?: string;
  vitamin_c?: string;
  calcium?: string;
  iron?: string;
}

export interface FatSecretFoodEntriesResponse {
  food_entries?: {
    food_entry: FatSecretFoodEntry[];
  } | null;
}

export const fatSecretFoodEntriesResponseSchema = z.object({
  food_entries: z
    .object({
      food_entry: z.array(
        z.object({
          food_entry_id: z.string(),
          food_entry_name: z.string(),
          food_entry_description: z.string(),
          food_id: z.string(),
          serving_id: z.string(),
          number_of_units: z.string(),
          meal: z.string(),
          date_int: z.string(),
          calories: z.string(),
          carbohydrate: z.string(),
          protein: z.string(),
          fat: z.string(),
          saturated_fat: z.string().optional(),
          polyunsaturated_fat: z.string().optional(),
          monounsaturated_fat: z.string().optional(),
          cholesterol: z.string().optional(),
          sodium: z.string().optional(),
          potassium: z.string().optional(),
          fiber: z.string().optional(),
          sugar: z.string().optional(),
          vitamin_a: z.string().optional(),
          vitamin_c: z.string().optional(),
          calcium: z.string().optional(),
          iron: z.string().optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
});

// ============================================================
// Parsed types
// ============================================================

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";

export interface ParsedFoodEntry {
  externalId: string;
  foodName: string;
  foodDescription: string;
  fatsecretFoodId: string;
  fatsecretServingId: string;
  numberOfUnits: number;
  meal: MealType;
  date: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  saturatedFatG?: number;
  polyunsaturatedFatG?: number;
  monounsaturatedFatG?: number;
  cholesterolMg?: number;
  sodiumMg?: number;
  potassiumMg?: number;
  fiberG?: number;
  sugarG?: number;
  vitaminAMcg?: number;
  vitaminCMg?: number;
  calciumMg?: number;
  ironMg?: number;
}

// ============================================================
// Parsing helpers
// ============================================================

/**
 * Convert FatSecret date_int (days since epoch) to ISO date string.
 */
function dateIntToIso(dateInt: string): string {
  const days = parseInt(dateInt, 10);
  const ms = days * 86400000; // days * 24h * 60m * 60s * 1000ms
  return new Date(ms).toISOString().split("T")[0] ?? "";
}

/**
 * Parse an optional numeric string — returns undefined if missing.
 */
function optNum(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const parsed = parseFloat(val);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalize FatSecret meal name to lowercase enum value.
 */
function normalizeMeal(meal: string): MealType {
  const lower = meal.toLowerCase();
  if (lower === "breakfast" || lower === "lunch" || lower === "dinner" || lower === "snack") {
    return lower;
  }
  return "other";
}

// ============================================================
// Category inference (keyword heuristic)
// ============================================================

const SUPPLEMENT_KEYWORDS = [
  "vitamin",
  "multivitamin",
  "supplement",
  "capsule",
  "capsules",
  "tablet",
  "tablets",
  "softgel",
  "softgels",
  "fish oil",
  "omega-3",
  "omega 3",
  "creatine",
  "collagen",
  "probiotic",
  "prebiotic",
  "magnesium",
  "zinc",
  "iron supplement",
  "calcium supplement",
  "ashwagandha",
  "turmeric",
  "curcumin",
  "melatonin",
  "coq10",
  "whey protein",
  "casein protein",
  "protein powder",
  "bcaa",
  "glutamine",
  "electrolyte",
  "extract",
];

/**
 * Dosage pattern: matches "200mg", "1000mcg", "5000IU", "500 mg", etc.
 */
const DOSAGE_PATTERN = /\b\d+\s*(?:mg|mcg|iu|µg)\b/i;

/**
 * Infer food category from the food entry name using keyword heuristics.
 * Returns "supplement" if the name matches supplement patterns, undefined otherwise.
 * This is a best-effort heuristic — API-based category enrichment (Premier tier) is more accurate.
 */
export function inferCategory(foodName: string): "supplement" | undefined {
  const lower = foodName.toLowerCase();

  // Check keyword matches
  for (const keyword of SUPPLEMENT_KEYWORDS) {
    if (lower.includes(keyword)) return "supplement";
  }

  // Check dosage patterns (e.g., "200mg", "5000IU") — strong supplement signal
  if (DOSAGE_PATTERN.test(foodName)) return "supplement";

  return undefined;
}

/**
 * Parse FatSecret food_entries.get response into ParsedFoodEntry array.
 */
export function parseFoodEntries(response: FatSecretFoodEntriesResponse): ParsedFoodEntry[] {
  const entries = response.food_entries?.food_entry;
  if (!entries || entries.length === 0) return [];

  return entries.map((e) => ({
    externalId: e.food_entry_id,
    foodName: e.food_entry_name,
    foodDescription: e.food_entry_description,
    fatsecretFoodId: e.food_id,
    fatsecretServingId: e.serving_id,
    numberOfUnits: parseFloat(e.number_of_units),
    meal: normalizeMeal(e.meal),
    date: dateIntToIso(e.date_int),
    calories: Number.parseFloat(e.calories),
    proteinG: parseFloat(e.protein),
    carbsG: parseFloat(e.carbohydrate),
    fatG: parseFloat(e.fat),
    saturatedFatG: optNum(e.saturated_fat),
    polyunsaturatedFatG: optNum(e.polyunsaturated_fat),
    monounsaturatedFatG: optNum(e.monounsaturated_fat),
    cholesterolMg: optNum(e.cholesterol),
    sodiumMg: optNum(e.sodium),
    potassiumMg: optNum(e.potassium),
    fiberG: optNum(e.fiber),
    sugarG: optNum(e.sugar),
    vitaminAMcg: optNum(e.vitamin_a),
    vitaminCMg: optNum(e.vitamin_c),
    calciumMg: optNum(e.calcium),
    ironMg: optNum(e.iron),
  }));
}
