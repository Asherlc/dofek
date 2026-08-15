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

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    {
      raw: (s: string) => s,
      join: (fragments: unknown[], separator: unknown) => ({ fragments, separator }),
    },
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

vi.mock(import("../lib/typed-sql.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeWithSchema: vi.fn(async (_db: unknown, _schema: unknown, _query: unknown) => []),
  };
});

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
    definition_id: "uuid-1",
    supplement_id: "schedule-uuid-1",
    user_id: "user-1",
    schedule_id: "schedule-uuid-1",
    supersedes_definition_id: null,
    name: "Multivitamin",
    sort_order: 0,
    amount: 5000,
    unit: "IU",
    form: "capsule",
    description: "Daily vitamin",
    meal: "breakfast",
    nutrition_data_id: "nd-uuid-1",
    effective_from: "2026-01-01",
    effective_to: null,
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

// Helper: create a mock DB and executeWithSchema result.
function createMockDb(opts: { viewRows?: Record<string, unknown>[] } = {}) {
  const mockExecute = vi.fn().mockResolvedValue([]);

  const mockedExecuteWithSchema = vi.mocked(executeWithSchema);
  mockedExecuteWithSchema.mockResolvedValue(opts.viewRows ?? []);

  return {
    db: { execute: mockExecute },
    mocks: {
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
});
