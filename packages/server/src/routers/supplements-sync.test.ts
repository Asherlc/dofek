import { describe, expect, it, vi } from "vitest";
import { NUTRIENT_KEYS, NUTRIENT_COLUMN_MAP } from "dofek/db/nutrient-columns";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("dofek/db/schema", () => ({
  supplement: {
    userId: "user_id",
    sortOrder: "sort_order",
    nutritionDataId: "nutrition_data_id",
  },
  nutritionData: {
    id: "id",
  },
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((col: string) => col),
  eq: vi.fn((col: string, val: string) => ({ col, val })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => s },
  ),
}));

vi.mock("dofek/jobs/queues", () => ({
  createSyncQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: "job-123" }),
  })),
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn() },
}));

import {
  type Supplement,
  toApiSupplement,
} from "./supplements.ts";

/** Build a view row (snake_case nutrients) with all fields populated. */
const NUTRIENT_SNAKE_VALUES: Record<string, number> = {
  calories: 10,
  protein_g: 0.5,
  carbs_g: 1.1,
  fat_g: 0.2,
  saturated_fat_g: 0.1,
  polyunsaturated_fat_g: 0.05,
  monounsaturated_fat_g: 0.04,
  trans_fat_g: 0.01,
  cholesterol_mg: 0.3,
  sodium_mg: 5,
  potassium_mg: 10,
  fiber_g: 0.1,
  sugar_g: 0.2,
  vitamin_a_mcg: 900,
  vitamin_c_mg: 90,
  vitamin_d_mcg: 125,
  vitamin_e_mg: 15,
  vitamin_k_mcg: 120,
  vitamin_b1_mg: 1.2,
  vitamin_b2_mg: 1.3,
  vitamin_b3_mg: 16,
  vitamin_b5_mg: 5,
  vitamin_b6_mg: 1.7,
  vitamin_b7_mcg: 30,
  vitamin_b9_mcg: 400,
  vitamin_b12_mcg: 2.4,
  calcium_mg: 1000,
  iron_mg: 18,
  magnesium_mg: 400,
  zinc_mg: 11,
  selenium_mcg: 55,
  copper_mg: 0.9,
  manganese_mg: 2.3,
  chromium_mcg: 35,
  iodine_mcg: 150,
  omega3_mg: 500,
  omega6_mg: 200,
};

/** Expected camelCase nutrient values after conversion */
const NUTRIENT_CAMEL_VALUES: Partial<Supplement> = {
  calories: 10,
  proteinG: 0.5,
  carbsG: 1.1,
  fatG: 0.2,
  saturatedFatG: 0.1,
  polyunsaturatedFatG: 0.05,
  monounsaturatedFatG: 0.04,
  transFatG: 0.01,
  cholesterolMg: 0.3,
  sodiumMg: 5,
  potassiumMg: 10,
  fiberG: 0.1,
  sugarG: 0.2,
  vitaminAMcg: 900,
  vitaminCMg: 90,
  vitaminDMcg: 125,
  vitaminEMg: 15,
  vitaminKMcg: 120,
  vitaminB1Mg: 1.2,
  vitaminB2Mg: 1.3,
  vitaminB3Mg: 16,
  vitaminB5Mg: 5,
  vitaminB6Mg: 1.7,
  vitaminB7Mcg: 30,
  vitaminB9Mcg: 400,
  vitaminB12Mcg: 2.4,
  calciumMg: 1000,
  ironMg: 18,
  magnesiumMg: 400,
  zincMg: 11,
  seleniumMcg: 55,
  copperMg: 0.9,
  manganeseMg: 2.3,
  chromiumMcg: 35,
  iodineMcg: 150,
  omega3Mg: 500,
  omega6Mg: 200,
};

/** Build a full view row (as returned by v_supplement_with_nutrition). */
function fullViewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    user_id: "user-1",
    name: "Multivitamin",
    sort_order: 0,
    amount: 5000,
    unit: "IU",
    form: "capsule",
    description: "Daily vitamin",
    meal: "breakfast",
    nutrition_data_id: "nd-uuid-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...NUTRIENT_SNAKE_VALUES,
    ...overrides,
  };
}

/** Build a view row where all optional fields are null. */
function minimalViewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nullNutrients = Object.fromEntries(
    Object.keys(NUTRIENT_SNAKE_VALUES).map((key) => [key, null]),
  );
  return fullViewRow({
    amount: null,
    unit: null,
    form: null,
    description: null,
    meal: null,
    ...nullNutrients,
    ...overrides,
  });
}

// ── toApiSupplement ──

describe("toApiSupplement", () => {
  it("includes all non-null optional fields (converting snake_case nutrients to camelCase)", () => {
    const row = fullViewRow();
    const result = toApiSupplement(row);

    expect(result.name).toBe("Multivitamin");
    expect(result.amount).toBe(5000);
    expect(result.unit).toBe("IU");
    expect(result.form).toBe("capsule");
    expect(result.description).toBe("Daily vitamin");
    expect(result.meal).toBe("breakfast");

    // All nutrient fields should be converted from snake_case to camelCase
    for (const key of NUTRIENT_KEYS) {
      const snakeColumn = NUTRIENT_COLUMN_MAP[key];
      if (snakeColumn && NUTRIENT_SNAKE_VALUES[snakeColumn] != null) {
        expect(result[key as keyof Supplement]).toBe(NUTRIENT_SNAKE_VALUES[snakeColumn]);
      }
    }
  });

  it("excludes null fields from the result", () => {
    const row = minimalViewRow();
    const result = toApiSupplement(row);

    expect(result).toEqual({ name: "Multivitamin" });
  });

  it("strips DB-only fields (id, user_id, sort_order, timestamps, nutrition_data_id)", () => {
    const row = fullViewRow();
    const result = toApiSupplement(row);

    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("user_id");
    expect(result).not.toHaveProperty("sort_order");
    expect(result).not.toHaveProperty("created_at");
    expect(result).not.toHaveProperty("updated_at");
    expect(result).not.toHaveProperty("nutrition_data_id");
  });

  it("includes only the subset of non-null fields", () => {
    const row = minimalViewRow({ amount: 5000, unit: "IU", vitamin_d_mcg: 125 });

    const result = toApiSupplement(row);
    expect(result).toEqual({
      name: "Multivitamin",
      amount: 5000,
      unit: "IU",
      vitaminDMcg: 125,
    });
  });
});
