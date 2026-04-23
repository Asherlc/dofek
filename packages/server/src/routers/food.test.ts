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

vi.mock("../lib/ai-nutrition.ts", () => ({
  analyzeNutrition: vi.fn().mockResolvedValue({
    nutrition: {
      foodName: "Apple",
      calories: 95,
      proteinG: 0.5,
      carbsG: 25,
      fatG: 0.3,
    },
    provider: "test-provider",
  }),
  analyzeNutritionItems: vi.fn().mockResolvedValue({
    items: [
      {
        foodName: "Apple",
        foodDescription: "1 medium",
        category: "fruit",
        meal: "snack",
        calories: 95,
        proteinG: 0.5,
        carbsG: 25,
        fatG: 0.3,
        fiberG: 4.4,
        saturatedFatG: 0.1,
        sugarG: 19,
        sodiumMg: 2,
      },
    ],
    provider: "test-provider",
  }),
}));

import { analyzeNutritionItems } from "../lib/ai-nutrition.ts";
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

  describe("search", () => {
    it("returns matching food entries", async () => {
      const rows = [{ food_name: "Chicken Breast", calories: 165 }];
      const caller = makeCaller(rows);
      const result = await caller.search({ query: "chicken" });
      expect(result).toEqual(rows);
    });
  });

  describe("create", () => {
    it("creates a food entry", async () => {
      const created = { id: "new-1", food_name: "Test Food", calories: 200 };
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]); // ensureDofekProvider
      execute.mockResolvedValueOnce([{ id: "new-1" }]); // CTE INSERT RETURNING id
      execute.mockResolvedValueOnce([created]); // SELECT FROM view
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.create({
        date: "2024-01-15",
        foodName: "Test Food",
        calories: 200,
      });
      expect(result).toEqual({ ...created, nutrients: {} });
    });
  });

  describe("update", () => {
    it("updates a food entry", async () => {
      const updated = { id: "f1", food_name: "Updated" };
      const caller = makeCaller([updated]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        foodName: "Updated",
      });
      expect(result).toEqual(updated);
    });

    it("returns null when no fields to update", async () => {
      const caller = makeCaller([]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toBeNull();
    });

    it("handles setting date field", async () => {
      const updated = { id: "f1", date: "2024-02-01" };
      const caller = makeCaller([updated]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        date: "2024-02-01",
      });
      expect(result).toEqual(updated);
    });

    it("handles setting null values", async () => {
      const updated = { id: "f1", meal: null };
      const caller = makeCaller([updated]);
      const result = await caller.update({
        id: "00000000-0000-0000-0000-000000000001",
        meal: null,
      });
      expect(result).toEqual(updated);
    });
  });

  describe("delete", () => {
    it("deletes a food entry", async () => {
      const caller = makeCaller([]);
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ success: true });
    });
  });

  describe("analyzeWithAi", () => {
    it("calls AI nutrition analysis", async () => {
      const caller = makeCaller([]);
      const result = await caller.analyzeWithAi({ description: "1 medium apple" });
      expect(result.nutrition).toHaveProperty("foodName", "Apple");
    });
  });

  describe("analyzeItemsWithAi", () => {
    it("returns parsed nutrition items from Slack-style AI parsing", async () => {
      const caller = makeCaller([]);
      const result = await caller.analyzeItemsWithAi({
        description: "two eggs and toast with butter",
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toHaveProperty("foodName", "Apple");
    });

    it("overrides AI meal guess using the current localized time", async () => {
      const mockedAnalyzeNutritionItems = vi.mocked(analyzeNutritionItems);
      mockedAnalyzeNutritionItems.mockResolvedValueOnce({
        items: [
          {
            foodName: "Eggs",
            foodDescription: "2 eggs",
            category: "eggs",
            meal: "dinner",
            calories: 140,
            proteinG: 12,
            carbsG: 1,
            fatG: 10,
            fiberG: 0,
            saturatedFatG: 3,
            sugarG: 1,
            sodiumMg: 140,
          },
        ],
        provider: "test-provider",
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T15:00:00.000Z"));
      try {
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "America/Los_Angeles",
        });
        const result = await caller.analyzeItemsWithAi({
          description: "two eggs",
        });

        const lastCall =
          mockedAnalyzeNutritionItems.mock.calls[mockedAnalyzeNutritionItems.mock.calls.length - 1];
        expect(lastCall?.[0]).toBe("two eggs");
        expect(lastCall?.[1]).toContain("7:00 AM");
        expect(result.items[0]?.meal).toBe("breakfast");
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { currentTime: "2026-01-15T09:00:00.000Z", expectedMeal: "breakfast" },
      { currentTime: "2026-01-15T10:00:00.000Z", expectedMeal: "lunch" },
      { currentTime: "2026-01-15T13:00:00.000Z", expectedMeal: "lunch" },
      { currentTime: "2026-01-15T14:00:00.000Z", expectedMeal: "snack" },
      { currentTime: "2026-01-15T16:00:00.000Z", expectedMeal: "snack" },
      { currentTime: "2026-01-15T17:00:00.000Z", expectedMeal: "dinner" },
    ])("infers $expectedMeal from current localized hour at $currentTime", async ({
      currentTime,
      expectedMeal,
    }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(currentTime));
      try {
        const caller = createCaller({
          db: { execute: vi.fn().mockResolvedValue([]) },
          userId: "user-1",
          timezone: "UTC",
        });
        const result = await caller.analyzeItemsWithAi({
          description: "meal for boundary test",
        });
        expect(result.items[0]?.meal).toBe(expectedMeal);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("quickAdd", () => {
    it("creates a quick food entry", async () => {
      const created = { id: "qa-1", food_name: "Quick Food", calories: 500 };
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]); // ensureDofekProvider
      execute.mockResolvedValueOnce([{ id: "qa-1" }]); // CTE INSERT RETURNING id
      execute.mockResolvedValueOnce([created]); // SELECT FROM view
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.quickAdd({
        date: "2024-01-15",
        meal: "lunch",
        foodName: "Quick Food",
        calories: 500,
      });
      expect(result).toEqual({ ...created, nutrients: {} });
    });
  });
});
