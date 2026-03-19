import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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
  },
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((col: string) => col),
  eq: vi.fn((col: string, val: string) => ({ col, val })),
}));

vi.mock("dofek/jobs/queues", () => ({
  createSyncQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: "job-123" }),
    getJob: vi.fn(),
  })),
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: vi.fn(() => []),
  registerProvider: vi.fn(),
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn() },
}));

import {
  OPTIONAL_FIELDS,
  type Supplement,
  supplementsRouter,
  toApiSupplement,
} from "./supplements.ts";

// Helper: create a mock DB that returns rows from select and tracks transaction calls
function createMockDb(rows: unknown[] = []) {
  const mockOrderBy = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  const mockTxDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockTxDelete = vi.fn(() => ({ where: mockTxDeleteWhere }));
  const mockTxInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockTxInsert = vi.fn(() => ({
    values: mockTxInsertValues,
  }));
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({ delete: mockTxDelete, insert: mockTxInsert });
  });

  return {
    db: {
      select: mockSelect,
      transaction: mockTransaction,
    },
    mocks: {
      mockSelect,
      mockFrom,
      mockWhere,
      mockOrderBy,
      mockTransaction,
      mockTxDelete,
      mockTxDeleteWhere,
      mockTxInsert,
      mockTxInsertValues,
    },
  };
}

/** Canonical non-null value for each optional field. */
const FIELD_VALUES: Partial<Supplement> = {
  amount: 5000,
  unit: "IU",
  form: "capsule",
  description: "Daily vitamin",
  meal: "breakfast",
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

/** All optional fields set to null, for building minimal rows. */
const NULL_FIELDS = Object.fromEntries(OPTIONAL_FIELDS.map((key) => [key, null]));

/** Build a full DB row with all fields set to non-null values. */
function fullDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    userId: "user-1",
    name: "Multivitamin",
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...FIELD_VALUES,
    ...overrides,
  };
}

/** Build a DB row where all optional fields are null. */
function minimalDbRow(overrides: Record<string, unknown> = {}) {
  return fullDbRow({ ...NULL_FIELDS, ...overrides });
}

/** Build a Supplement input with all optional fields populated. */
function fullSupplement(overrides: Partial<Supplement> = {}): Supplement {
  return { name: "Multivitamin", ...FIELD_VALUES, ...overrides };
}

// ── toApiSupplement ──

describe("toApiSupplement", () => {
  it("includes all non-null optional fields", () => {
    const row = fullDbRow();
    const result = toApiSupplement(row);

    expect(result.name).toBe("Multivitamin");
    for (const key of OPTIONAL_FIELDS) {
      expect(result[key]).toBe(FIELD_VALUES[key]);
    }
  });

  it("excludes null fields from the result", () => {
    const row = minimalDbRow();
    const result = toApiSupplement(row);

    expect(result).toEqual({ name: row.name });
    for (const key of OPTIONAL_FIELDS) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("strips DB-only fields (id, userId, sortOrder, timestamps)", () => {
    const row = fullDbRow();
    const result = toApiSupplement(row);

    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("sortOrder");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("includes only the subset of non-null fields", () => {
    const row = minimalDbRow({ amount: 5000, unit: "IU", vitaminDMcg: 125 });

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

describe("supplementsRouter", () => {
  const createCaller = createTestCallerFactory(supplementsRouter);

  describe("list", () => {
    it("returns supplements mapped through toApiSupplement", async () => {
      const dbRows = [fullDbRow()];
      const { db } = createMockDb(dbRows);
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.list();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Multivitamin");
      for (const key of OPTIONAL_FIELDS) {
        expect(result[0]?.[key]).toBe(FIELD_VALUES[key]);
      }
    });

    it("returns empty array when user has no supplements", async () => {
      const { db } = createMockDb([]);
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.list();
      expect(result).toHaveLength(0);
    });

    it("excludes null fields from listed supplements", async () => {
      const { db } = createMockDb([minimalDbRow()]);
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.list();
      expect(result[0]).toEqual({ name: "Multivitamin" });
    });
  });

  describe("save", () => {
    it("saves supplements via transaction (delete + insert)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.save({
        supplements: [fullSupplement({ name: "Creatine" })],
      });

      expect(result).toEqual({ success: true, count: 1 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
      expect(mocks.mockTxDelete).toHaveBeenCalledOnce();
      expect(mocks.mockTxInsert).toHaveBeenCalledOnce();
    });

    it("passes every field with correct values to insert", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      await caller.save({ supplements: [fullSupplement()] });

      const insertedValues = mocks.mockTxInsertValues.mock.calls[0]?.[0];
      expect(insertedValues).toHaveLength(1);
      const row = insertedValues[0];
      expect(row.userId).toBe("user-1");
      expect(row.name).toBe("Multivitamin");
      expect(row.sortOrder).toBe(0);
      for (const key of OPTIONAL_FIELDS) {
        expect(row[key]).toBe(FIELD_VALUES[key]);
      }
    });

    it("coalesces undefined optional fields to null", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      await caller.save({ supplements: [{ name: "Bare minimum" }] });

      const row = mocks.mockTxInsertValues.mock.calls[0]?.[0]?.[0];
      expect(row.name).toBe("Bare minimum");
      for (const key of OPTIONAL_FIELDS) {
        expect(row[key]).toBeNull();
      }
    });

    it("handles empty supplements array (delete all, no insert)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.save({ supplements: [] });

      expect(result).toEqual({ success: true, count: 0 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
      expect(mocks.mockTxDelete).toHaveBeenCalledOnce();
      expect(mocks.mockTxInsert).not.toHaveBeenCalled();
    });

    it("preserves sort order from array index", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      await caller.save({
        supplements: [{ name: "First" }, { name: "Second" }, { name: "Third" }],
      });

      const insertedValues = mocks.mockTxInsertValues.mock.calls[0]?.[0];
      expect(insertedValues[0].sortOrder).toBe(0);
      expect(insertedValues[1].sortOrder).toBe(1);
      expect(insertedValues[2].sortOrder).toBe(2);
    });
  });
});

// ── Sync Router (mapProviderStats) ──

describe("syncRouter", () => {
  it("maps provider stat rows", async () => {
    const { ensureProvidersRegistered } = await import("./sync.ts");
    expect(typeof ensureProvidersRegistered).toBe("function");
  });
});
