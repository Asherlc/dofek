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

vi.mock("../lib/typed-sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/typed-sql.ts")>()),
  executeWithSchema: vi.fn(
    async (
      db: { execute: (query: unknown) => Promise<unknown[]> },
      _schema: unknown,
      query: unknown,
    ) => db.execute(query),
  ),
}));

import { logger } from "../logger.ts";
import { foodRouter } from "./food.ts";

const createCaller = createTestCallerFactory(foodRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("foodRouter", () => {
  describe("list", () => {
    it("returns food entries for date range", async () => {
      const rows = [{ id: "f1", food_name: "Chicken", calories: 300 }];
      const caller = makeCaller(rows);
      const result = await caller.list({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });
      expect(result).toEqual(rows);
    });

    it("filters by meal when specified", async () => {
      const rows = [{ id: "f1", food_name: "Eggs", meal: "breakfast" }];
      const caller = makeCaller(rows);
      const result = await caller.list({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        meal: "breakfast",
      });
      expect(result).toEqual(rows);
    });
  });

  describe("byDate", () => {
    it("returns food entries for a specific date", async () => {
      const rows = [{ id: "f1", food_name: "Lunch" }];
      const caller = makeCaller(rows);
      const result = await caller.byDate({ date: "2024-01-15" });
      expect(result).toEqual(rows);
    });

    it("logs when no rows are returned", async () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const caller = makeCaller([]);
      await caller.byDate({ date: "2024-01-15" });
      expect(infoSpy).toHaveBeenCalledWith(
        "[food] byDate returned 0 rows for userId=user-1 date=2024-01-15",
      );
    });
  });

  describe("dailyTotals", () => {
    it("returns aggregated daily totals", async () => {
      const rows = [
        {
          date: "2024-01-15",
          calories: 2100,
          protein_g: 150,
          carbs_g: 250,
          fat_g: 70,
          fiber_g: 30,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dailyTotals({ days: 30 });
      expect(result).toEqual(rows);
    });
  });
});
