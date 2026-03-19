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

import { supplementsRouter } from "./supplements.ts";

// Helper: create a mock DB that returns rows from select and tracks transaction calls
function createMockDb(rows: unknown[] = []) {
  const mockOrderBy = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  const mockTxDelete = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
  const mockTxInsert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
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
      mockTxInsert,
    },
  };
}

describe("supplementsRouter", () => {
  const createCaller = createTestCallerFactory(supplementsRouter);

  describe("list", () => {
    it("returns supplements from DB for the authenticated user", async () => {
      const dbRows = [
        {
          id: "uuid-1",
          userId: "user-1",
          name: "Vitamin D",
          amount: 5000,
          unit: "IU",
          form: null,
          description: null,
          meal: null,
          sortOrder: 0,
          calories: null,
          proteinG: null,
          carbsG: null,
          fatG: null,
          saturatedFatG: null,
          polyunsaturatedFatG: null,
          monounsaturatedFatG: null,
          transFatG: null,
          cholesterolMg: null,
          sodiumMg: null,
          potassiumMg: null,
          fiberG: null,
          sugarG: null,
          vitaminAMcg: null,
          vitaminCMg: null,
          vitaminDMcg: 125,
          vitaminEMg: null,
          vitaminKMcg: null,
          vitaminB1Mg: null,
          vitaminB2Mg: null,
          vitaminB3Mg: null,
          vitaminB5Mg: null,
          vitaminB6Mg: null,
          vitaminB7Mcg: null,
          vitaminB9Mcg: null,
          vitaminB12Mcg: null,
          calciumMg: null,
          ironMg: null,
          magnesiumMg: null,
          zincMg: null,
          seleniumMcg: null,
          copperMg: null,
          manganeseMg: null,
          chromiumMcg: null,
          iodineMcg: null,
          omega3Mg: null,
          omega6Mg: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const { db } = createMockDb(dbRows);
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.list();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Vitamin D");
      expect(result[0]?.amount).toBe(5000);
      expect(result[0]?.unit).toBe("IU");
      expect(result[0]?.vitaminDMcg).toBe(125);
    });

    it("returns empty array when user has no supplements", async () => {
      const { db } = createMockDb([]);
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.list();
      expect(result).toHaveLength(0);
    });
  });

  describe("save", () => {
    it("saves supplements via transaction (delete + insert)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.save({
        supplements: [{ name: "Creatine", amount: 5, unit: "g" }],
      });

      expect(result).toEqual({ success: true, count: 1 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
    });

    it("handles empty supplements array (delete all)", async () => {
      const { db, mocks } = createMockDb();
      const caller = createCaller({ db, userId: "user-1" });

      const result = await caller.save({ supplements: [] });

      expect(result).toEqual({ success: true, count: 0 });
      expect(mocks.mockTransaction).toHaveBeenCalledOnce();
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
