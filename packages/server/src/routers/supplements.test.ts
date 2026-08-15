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

// ---------------------------------------------------------------------------
// Router procedure tests
// ---------------------------------------------------------------------------

describe("supplementsRouter", () => {
  async function makeCaller(executeResult: unknown[] = []) {
    const execute = vi.fn().mockResolvedValue(executeResult);
    const db = { execute };

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
      expect(result).toEqual([]);
    });

    it("preserves the exact installed-client V1 definition shape", async () => {
      const { caller } = await makeCaller([
        {
          definition_id: "supplement-version-1",
          supplement_id: "schedule-1",
          user_id: "user-1",
          schedule_id: "schedule-1",
          supersedes_definition_id: null,
          name: "Vitamin D",
          amount: 50,
          unit: "mcg",
          form: null,
          description: null,
          meal: "breakfast",
          sort_order: 0,
          effective_from: "2026-01-01",
          effective_to: null,
          nutrition_data_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(await caller.list()).toEqual([
        {
          name: "Vitamin D",
          amount: 50,
          unit: "mcg",
          meal: "breakfast",
        },
      ]);
    });
  });

  describe("occurrences", () => {
    it("returns server-computed statuses and counts", async () => {
      const { caller } = await makeCaller([
        {
          id: "event-1",
          schedule_id: "schedule-1",
          supplement_id: "supplement-1",
          supplement_name: "Vitamin D",
          scheduled_date: "2026-07-27",
          status: "planned",
          supersedes_event_id: null,
          provider_id: "auto-supplements",
          source_name: "Auto-Supplements",
          recorded_at: "2026-07-27T08:00:00.000Z",
          created_at: "2026-07-27T08:00:00.000Z",
          is_current: true,
        },
      ]);

      expect(await caller.occurrences({ days: 7 })).toEqual({
        counts: { planned: 1, taken: 0, skipped: 0, unknown: 0 },
        occurrences: [
          {
            currentEventId: "event-1",
            scheduleId: "schedule-1",
            supplementId: "supplement-1",
            supplementName: "Vitamin D",
            scheduledDate: "2026-07-27",
            status: "planned",
            history: [
              {
                id: "event-1",
                providerId: "auto-supplements",
                recordedAt: "2026-07-27T08:00:00.000Z",
                sourceName: "Auto-Supplements",
                status: "planned",
              },
            ],
          },
        ],
      });
    });

    it("rejects unbounded history windows", async () => {
      const { caller } = await makeCaller([]);
      await expect(caller.occurrences({ days: 31 })).rejects.toThrow();
    });

    it("applies the default history window when days is omitted", async () => {
      const occurrences = vi
        .spyOn(SupplementsRepository.prototype, "occurrences")
        .mockResolvedValue({
          counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
          occurrences: [],
        });
      const { caller } = await makeCaller([]);

      await expect(caller.occurrences({})).resolves.toEqual({
        counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
        occurrences: [],
      });
      expect(occurrences).toHaveBeenCalledWith(7);
      occurrences.mockRestore();
    });

    it("accepts both bounded history-window endpoints", async () => {
      const occurrences = vi
        .spyOn(SupplementsRepository.prototype, "occurrences")
        .mockResolvedValue({
          counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
          occurrences: [],
        });
      const { caller } = await makeCaller([]);

      await expect(caller.occurrences({ days: 1 })).resolves.toBeDefined();
      await expect(caller.occurrences({ days: 30 })).resolves.toBeDefined();
      expect(occurrences).toHaveBeenNthCalledWith(1, 1);
      expect(occurrences).toHaveBeenNthCalledWith(2, 30);
      occurrences.mockRestore();
    });

    it("rejects history windows below the lower bound", async () => {
      const { caller } = await makeCaller([]);

      await expect(caller.occurrences({ days: 0 })).rejects.toThrow();
    });
  });

  describe("schema initialization", () => {
    it("enforces the occurrence default and inclusive day bounds after a fresh module load", async () => {
      vi.resetModules();
      const { SupplementsRepository: FreshSupplementsRepository } = await import(
        "../repositories/supplements-repository.ts"
      );
      const occurrences = vi
        .spyOn(FreshSupplementsRepository.prototype, "occurrences")
        .mockResolvedValue({
          counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
          occurrences: [],
        });
      const { caller } = await makeCaller([]);

      await expect(caller.occurrences({})).resolves.toBeDefined();
      await expect(caller.occurrences({ days: 1 })).resolves.toBeDefined();
      await expect(caller.occurrences({ days: 30 })).resolves.toBeDefined();
      await expect(caller.occurrences({ days: 0 })).rejects.toThrow();
      await expect(caller.occurrences({ days: 31 })).rejects.toThrow();
      expect(occurrences.mock.calls).toEqual([[7], [1], [30]]);
      occurrences.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// toApiSupplement utility tests
// ---------------------------------------------------------------------------

import { SupplementsRepository, toApiSupplement } from "../repositories/supplements-repository.ts";

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
