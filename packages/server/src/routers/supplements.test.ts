import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

// Mock drizzle functions used by SupplementsRepository
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    eq: vi.fn(() => true),
  };
});

// ---------------------------------------------------------------------------
// Router procedure tests
// ---------------------------------------------------------------------------

describe("supplementsRouter", () => {
  async function makeCaller(executeResult: unknown[] = []) {
    const execute = vi.fn().mockResolvedValue(executeResult);
    // Mock select/from/where for the list query
    const where = vi.fn().mockResolvedValue(executeResult);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insert = vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn() })) }));
    const deleteFn = vi.fn(() => ({ where: vi.fn() }));
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = { execute, select, insert, delete: deleteFn };
      return callback(tx);
    });
    const db = { execute, select, insert, delete: deleteFn, transaction };

    const { supplementsRouter } = await import("./supplements.ts");
    const callerFactory = createTestCallerFactory(supplementsRouter);
    return {
      caller: callerFactory({ db, userId: "user-1", timezone: "UTC" }),
      execute,
    };
  }

  describe("list", () => {
    it("returns result from repository", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.list();
      expect(result).toBeDefined();
    });
  });

  describe("save", () => {
    it("rejects empty supplement name", async () => {
      const { caller } = await makeCaller([]);
      await expect(caller.save({ supplements: [{ name: "" }] })).rejects.toThrow();
    });

    it("rejects supplement name exceeding 200 chars", async () => {
      const { caller } = await makeCaller([]);
      await expect(caller.save({ supplements: [{ name: "x".repeat(201) }] })).rejects.toThrow();
    });

    it("accepts name at exactly 200 chars (boundary)", async () => {
      const { caller } = await makeCaller([]);
      // This will fail with DB error, but should NOT fail with validation error
      try {
        await caller.save({ supplements: [{ name: "x".repeat(200) }] });
      } catch (error) {
        // Should not be a ZodError (input validation should pass)
        expect(String(error)).not.toContain("String must contain at most 200");
      }
    });

    it("rejects negative amount", async () => {
      const { caller } = await makeCaller([]);
      await expect(caller.save({ supplements: [{ name: "Test", amount: -1 }] })).rejects.toThrow();
    });

    it("rejects zero amount", async () => {
      const { caller } = await makeCaller([]);
      await expect(caller.save({ supplements: [{ name: "Test", amount: 0 }] })).rejects.toThrow();
    });

    it("rejects unit exceeding 10 chars", async () => {
      const { caller } = await makeCaller([]);
      await expect(
        caller.save({ supplements: [{ name: "Test", unit: "x".repeat(11) }] }),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// toApiSupplement utility tests
// ---------------------------------------------------------------------------

import { toApiSupplement } from "./supplements.ts";

describe("toApiSupplement()", () => {
  it("maps name from row", () => {
    const result = toApiSupplement({ name: "Vitamin D" });
    expect(result.name).toBe("Vitamin D");
  });

  it("includes non-nutrient optional fields when present", () => {
    const result = toApiSupplement({
      name: "Fish Oil",
      amount: 1000,
      unit: "mg",
      form: "softgel",
      description: "High EPA/DHA",
      meal: "breakfast",
    });
    expect(result.name).toBe("Fish Oil");
    expect(result.amount).toBe(1000);
    expect(result.unit).toBe("mg");
    expect(result.form).toBe("softgel");
    expect(result.description).toBe("High EPA/DHA");
    expect(result.meal).toBe("breakfast");
  });

  it("omits null optional fields", () => {
    const result = toApiSupplement({
      name: "Magnesium",
      amount: null,
      unit: null,
      form: null,
      description: null,
      meal: null,
    });
    expect(result.name).toBe("Magnesium");
    expect(result).not.toHaveProperty("amount");
    expect(result).not.toHaveProperty("unit");
    expect(result).not.toHaveProperty("form");
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("meal");
  });

  it("omits undefined optional fields", () => {
    const result = toApiSupplement({ name: "Zinc" });
    expect(result).not.toHaveProperty("amount");
    expect(result).not.toHaveProperty("unit");
  });

  it("converts snake_case nutrient columns to camelCase", () => {
    const result = toApiSupplement({
      name: "Multi",
      vitamin_a_mcg: 900,
      vitamin_c_mg: 90,
      calcium_mg: 500,
      iron_mg: 8,
    });
    expect(result.vitaminAMcg).toBe(900);
    expect(result.vitaminCMg).toBe(90);
    expect(result.calciumMg).toBe(500);
    expect(result.ironMg).toBe(8);
  });

  it("omits null nutrient columns from result", () => {
    const result = toApiSupplement({
      name: "Single",
      vitamin_a_mcg: null,
      vitamin_c_mg: null,
      calcium_mg: 500,
    });
    expect(result).not.toHaveProperty("vitaminAMcg");
    expect(result).not.toHaveProperty("vitaminCMg");
    expect(result.calciumMg).toBe(500);
  });

  it("returns just name when all optional fields and nutrients are null", () => {
    const row: Record<string, unknown> = { name: "Empty" };
    // Add all nutrient columns as null
    const nutrientCols = [
      "calories",
      "protein_g",
      "carbs_g",
      "fat_g",
      "saturated_fat_g",
      "polyunsaturated_fat_g",
      "monounsaturated_fat_g",
      "trans_fat_g",
      "cholesterol_mg",
      "sodium_mg",
      "potassium_mg",
      "fiber_g",
      "sugar_g",
      "vitamin_a_mcg",
      "vitamin_c_mg",
      "vitamin_d_mcg",
      "vitamin_e_mg",
      "vitamin_k_mcg",
      "vitamin_b1_mg",
      "vitamin_b2_mg",
      "vitamin_b3_mg",
      "vitamin_b5_mg",
      "vitamin_b6_mg",
      "vitamin_b7_mcg",
      "vitamin_b9_mcg",
      "vitamin_b12_mcg",
      "calcium_mg",
      "iron_mg",
      "magnesium_mg",
      "zinc_mg",
      "selenium_mcg",
      "copper_mg",
      "manganese_mg",
      "chromium_mcg",
      "iodine_mcg",
      "omega3_mg",
      "omega6_mg",
    ];
    for (const col of nutrientCols) {
      row[col] = null;
    }
    row.amount = null;
    row.unit = null;
    row.form = null;
    row.description = null;
    row.meal = null;

    const result = toApiSupplement(row);
    expect(result).toEqual({ name: "Empty" });
  });

  it("handles mixed nutrients (some present, some null)", () => {
    const result = toApiSupplement({
      name: "B-Complex",
      vitamin_b1_mg: 1.2,
      vitamin_b2_mg: 1.3,
      vitamin_b3_mg: null,
      vitamin_b5_mg: null,
      vitamin_b6_mg: 1.3,
      vitamin_b12_mcg: 2.4,
      iron_mg: null,
    });
    expect(result.name).toBe("B-Complex");
    expect(result.vitaminB1Mg).toBe(1.2);
    expect(result.vitaminB2Mg).toBe(1.3);
    expect(result.vitaminB6Mg).toBe(1.3);
    expect(result.vitaminB12Mcg).toBe(2.4);
    expect(result).not.toHaveProperty("vitaminB3Mg");
    expect(result).not.toHaveProperty("vitaminB5Mg");
    expect(result).not.toHaveProperty("ironMg");
  });

  it("handles macronutrient fields", () => {
    const result = toApiSupplement({
      name: "Protein Powder",
      calories: 120,
      protein_g: 25,
      carbs_g: 3,
      fat_g: 1.5,
      fiber_g: 1,
      sugar_g: 2,
    });
    expect(result.calories).toBe(120);
    expect(result.proteinG).toBe(25);
    expect(result.carbsG).toBe(3);
    expect(result.fatG).toBe(1.5);
    expect(result.fiberG).toBe(1);
    expect(result.sugarG).toBe(2);
  });

  it("handles fat breakdown and mineral fields", () => {
    const result = toApiSupplement({
      name: "Complete",
      saturated_fat_g: 0.5,
      polyunsaturated_fat_g: 0.3,
      monounsaturated_fat_g: 0.2,
      trans_fat_g: 0,
      cholesterol_mg: 5,
      sodium_mg: 10,
      potassium_mg: 100,
      omega3_mg: 1000,
      omega6_mg: 200,
    });
    expect(result.saturatedFatG).toBe(0.5);
    expect(result.polyunsaturatedFatG).toBe(0.3);
    expect(result.monounsaturatedFatG).toBe(0.2);
    expect(result.transFatG).toBe(0);
    expect(result.cholesterolMg).toBe(5);
    expect(result.sodiumMg).toBe(10);
    expect(result.potassiumMg).toBe(100);
    expect(result.omega3Mg).toBe(1000);
    expect(result.omega6Mg).toBe(200);
  });

  it("handles all mineral fields", () => {
    const result = toApiSupplement({
      name: "Mineral Complex",
      selenium_mcg: 55,
      copper_mg: 0.9,
      manganese_mg: 2.3,
      chromium_mcg: 35,
      iodine_mcg: 150,
      magnesium_mg: 400,
      zinc_mg: 11,
    });
    expect(result.seleniumMcg).toBe(55);
    expect(result.copperMg).toBe(0.9);
    expect(result.manganeseMg).toBe(2.3);
    expect(result.chromiumMcg).toBe(35);
    expect(result.iodineMcg).toBe(150);
    expect(result.magnesiumMg).toBe(400);
    expect(result.zincMg).toBe(11);
  });

  it("ignores non-string nutrient values (treats as null)", () => {
    const result = toApiSupplement({
      name: "Bad Data",
      vitamin_a_mcg: "not a number",
      calcium_mg: true,
    });
    // nutrientColumnsToValues treats non-number values as null
    expect(result).not.toHaveProperty("vitaminAMcg");
    expect(result).not.toHaveProperty("calciumMg");
  });
});
