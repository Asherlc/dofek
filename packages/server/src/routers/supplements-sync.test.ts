import { NUTRIENT_COLUMN_MAP, NUTRIENT_KEYS } from "dofek/db/nutrient-columns";
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

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(async (_db: unknown, _schema: unknown, _query: unknown) => []),
}));

import { executeWithSchema } from "../lib/typed-sql.ts";
import { toApiSupplement } from "../repositories/supplements-repository.ts";
import { supplementsRouter } from "./supplements.ts";

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
        const resultRecord: Record<string, unknown> = result;
        expect(resultRecord[key]).toBe(NUTRIENT_SNAKE_VALUES[snakeColumn]);
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

// ── supplementsRouter ──

// Helper: create a mock DB that tracks transaction calls and executeWithSchema results
function createMockDb(opts: { viewRows?: Record<string, unknown>[] } = {}) {
  const mockExecute = vi.fn().mockResolvedValue([]);
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "nd-new-uuid" }]);
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      select: mockSelect,
      delete: mockDelete,
      insert: mockInsert,
      execute: mockExecute,
    });
  });

  // Set up executeWithSchema mock to return view rows for the list handler
  const mockedExecuteWithSchema = vi.mocked(executeWithSchema);
  mockedExecuteWithSchema.mockResolvedValue(opts.viewRows ?? []);

  return {
    db: {
      execute: mockExecute,
      transaction: mockTransaction,
    },
    mocks: {
      mockExecute,
      mockTransaction,
      mockSelect,
      mockSelectFrom,
      mockSelectWhere,
      mockDelete,
      mockDeleteWhere,
      mockInsert,
      mockInsertValues,
      mockInsertReturning,
      mockedExecuteWithSchema,
    },
  };
}

describe("supplementsRouter", () => {
  const createCaller = createTestCallerFactory(supplementsRouter);

  describe("list", () => {
    it("returns supplements mapped through toApiSupplement", async () => {
      const { db } = createMockDb({ viewRows: [fullViewRow()] });
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const result = await caller.list();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Multivitamin");
      expect(result[0]?.amount).toBe(5000);
      expect(result[0]?.unit).toBe("IU");
    });

    it("returns empty array when user has no supplements", async () => {
      const { db } = createMockDb({ viewRows: [] });
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const result = await caller.list();
      expect(result).toHaveLength(0);
    });

    it("excludes null fields from listed supplements", async () => {
      const { db } = createMockDb({ viewRows: [minimalViewRow()] });
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const result = await caller.list();
      expect(result[0]).toEqual({ name: "Multivitamin" });
    });

    it("calls executeWithSchema with the view query", async () => {
      const { db, mocks } = createMockDb({ viewRows: [] });
      const callsBefore = mocks.mockedExecuteWithSchema.mock.calls.length;
      const caller = createCaller({ db, userId: "user-1" });

      await caller.list();
      expect(mocks.mockedExecuteWithSchema).toHaveBeenCalledTimes(callsBefore + 1);
    });
  });

  describe("save", () => {
    it("saves supplements via transaction (delete + insert)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const result = await caller.save({
        supplements: [{ name: "Creatine", calories: 0 }],
      });

      expect(result).toEqual({ success: true, count: 1 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
    });

    it("deletes existing supplements and their nutrition_data in the transaction", async () => {
      const { db, mocks } = createMockDb();
      // Simulate existing supplements with nutrition_data
      mocks.mockSelectWhere.mockResolvedValueOnce([
        { nutritionDataId: "old-nd-1" },
        { nutritionDataId: "old-nd-2" },
      ]);
      const caller = createCaller({ db, userId: "user-1" });

      await caller.save({ supplements: [{ name: "New Supp" }] });

      // Should call delete for supplement and nutrition_data
      expect(mocks.mockDelete).toHaveBeenCalledTimes(2);
    });

    it("inserts nutrition_data then supplement for each supplement", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      await caller.save({
        supplements: [
          { name: "First", vitaminDMcg: 50 },
          { name: "Second", calories: 10 },
        ],
      });

      // Two nutrition_data inserts
      expect(mocks.mockInsert).toHaveBeenCalledTimes(2);
      // Two supplement inserts via execute
      expect(mocks.mockExecute).toHaveBeenCalledTimes(2);
    });

    it("handles empty supplements array (delete all, no insert)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const result = await caller.save({ supplements: [] });

      expect(result).toEqual({ success: true, count: 0 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
      expect(mocks.mockInsert).not.toHaveBeenCalled();
    });

    it("passes nutrient values through to nutrition_data insert", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      await caller.save({
        supplements: [{ name: "Test", vitaminDMcg: 125, calories: 0 }],
      });

      const insertedValues = mocks.mockInsertValues.mock.calls[0]?.[0];
      expect(insertedValues.vitaminDMcg).toBe(125);
      expect(insertedValues.calories).toBe(0);
    });

    it("passes all truthy nutrient values through without coercing to null", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      const allNutrients = {
        name: "Complete",
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

      await caller.save({ supplements: [allNutrients] });

      const insertedValues = mocks.mockInsertValues.mock.calls[0]?.[0];
      // Verify every truthy nutrient value is passed through (not coerced to null)
      for (const [key, value] of Object.entries(allNutrients)) {
        if (key === "name") continue;
        expect(insertedValues[key], `nutrient ${key} should be ${value}`).toBe(value);
      }
    });

    it("passes optional non-nutrient fields through to supplement insert", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

      await caller.save({
        supplements: [
          {
            name: "Fish Oil",
            amount: 2,
            unit: "caps",
            form: "softgel",
            description: "Omega-3",
            meal: "breakfast",
          },
        ],
      });

      // The supplement insert is done via tx.execute with a SQL template
      const sqlCall = mocks.mockExecute.mock.calls[0]?.[0];
      // The sql tagged template returns { strings, values }
      // Values order: userId, name, amount, unit, form, description, meal, sortIndex, ndId
      expect(sqlCall.values).toContain("Fish Oil");
      expect(sqlCall.values).toContain(2);
      expect(sqlCall.values).toContain("caps");
      expect(sqlCall.values).toContain("softgel");
      expect(sqlCall.values).toContain("Omega-3");
      expect(sqlCall.values).toContain("breakfast");
    });
  });
});
