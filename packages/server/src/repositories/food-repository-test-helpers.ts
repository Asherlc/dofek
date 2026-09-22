import { vi } from "vitest";

/** Build a realistic food entry row from the v_food_entry_with_nutrition view. */
export function makeFoodEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    provider_id: "dofek",
    user_id: "user-1",
    external_id: null,
    date: "2024-06-15",
    meal: "lunch",
    food_name: "Chicken Breast",
    food_description: "Grilled, 200g",
    category: "meat",
    provider_food_id: null,
    provider_serving_id: null,
    number_of_units: 1,
    logged_at: "2024-06-15T12:00:00Z",
    source_name: null,
    started_at: null,
    ended_at: null,
    barcode: null,
    serving_unit: null,
    serving_weight_grams: null,
    nutrition_data_id: "nd-1",
    raw: null,
    confirmed: true,
    created_at: "2024-06-15T12:00:00Z",
    calories: 330,
    protein_g: 40,
    carbs_g: 0,
    fat_g: 8,
    saturated_fat_g: null,
    polyunsaturated_fat_g: null,
    monounsaturated_fat_g: null,
    trans_fat_g: null,
    cholesterol_mg: null,
    sodium_mg: null,
    potassium_mg: null,
    fiber_g: null,
    sugar_g: null,
    vitamin_a_mcg: null,
    vitamin_c_mg: null,
    vitamin_d_mcg: null,
    vitamin_e_mg: null,
    vitamin_k_mcg: null,
    vitamin_b1_mg: null,
    vitamin_b2_mg: null,
    vitamin_b3_mg: null,
    vitamin_b5_mg: null,
    vitamin_b6_mg: null,
    vitamin_b7_mcg: null,
    vitamin_b9_mcg: null,
    vitamin_b12_mcg: null,
    calcium_mg: null,
    iron_mg: null,
    magnesium_mg: null,
    zinc_mg: null,
    selenium_mcg: null,
    copper_mg: null,
    manganese_mg: null,
    chromium_mcg: null,
    iodine_mcg: null,
    omega3_mg: null,
    omega6_mg: null,
    ...overrides,
  };
}

export function collectSqlValues(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [value];
  const queryChunks = Reflect.get(value, "queryChunks");
  if (Array.isArray(queryChunks)) return queryChunks.flatMap(collectSqlValues);
  const rawValue = Reflect.get(value, "value");
  if (Array.isArray(rawValue)) return rawValue.flatMap(collectSqlValues);
  return rawValue === undefined ? [] : [rawValue];
}

export const availableResolutionRow = {
  resolution_status: "available",
  resolution_message: "Totals use the only available nutrition source.",
  source_providers: ["dofek"],
  contributing_providers: ["dofek"],
  excluded_providers: [],
  source_labels: ["dofek"],
  contributing_source_labels: ["dofek"],
  excluded_source_labels: [],
  contribution_grain: "itemized",
  contribution_source_label: "dofek",
};

export function makeDailyTotalsRow(overrides: Record<string, unknown> = {}) {
  return {
    date: "2024-06-15",
    calories: 2100,
    protein_g: 150,
    carbs_g: 200,
    fat_g: 80,
    fiber_g: 25,
    ...availableResolutionRow,
    ...overrides,
  };
}

export function makeFoodSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    food_name: "Chicken Breast",
    food_description: "Grilled, 200g",
    category: "meat",
    calories: 330,
    protein_g: 40,
    carbs_g: 0,
    fat_g: 8,
    fiber_g: 0,
    number_of_units: 1,
    ...overrides,
  };
}

export function makeRepository<T>(
  Repository: new (
    db: { execute: ReturnType<typeof vi.fn> },
    userId: string,
    timezone: string,
  ) => T,
  rows: Record<string, unknown>[] = [],
) {
  const execute = vi.fn().mockResolvedValue(rows);
  const db = { execute };
  const repo = new Repository(db, "user-1", "UTC");
  return { repo, execute };
}
