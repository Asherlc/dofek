import { captureException } from "dofek/lib/error-reporting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const cacheMocks = vi.hoisted(() => ({
  invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
}));

const aiObservabilityMocks = vi.hoisted(() => ({
  withAiGenerationContext: vi.fn(
    async (_context: { userId?: string }, operation: () => Promise<unknown>): Promise<unknown> =>
      operation(),
  ),
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    invalidateByPrefix: cacheMocks.invalidateByPrefix,
  },
}));

vi.mock("dofek/lib/ai-observability", () => aiObservabilityMocks);

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

function makeConflictCaller() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: "f1", food_name: "Lunch" }])
    .mockResolvedValueOnce([
      {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        breakfast_calories: 0,
        lunch_calories: 0,
        dinner_calories: 0,
        snack_calories: 0,
        other_calories: 0,
        resolution_status: "source_conflict",
        resolution_message:
          "Totals are unavailable because nutrition sources overlap and no canonical contribution set can be determined.",
        source_providers: ["cronometer", "fatsecret"],
        contributing_providers: [],
        excluded_providers: ["cronometer", "fatsecret"],
        source_labels: ["cronometer", "fatsecret"],
        contributing_source_labels: [],
        excluded_source_labels: ["cronometer", "fatsecret"],
        contribution_grain: null,
        contribution_source_label: null,
      },
    ]);
  return createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("foodRouter", () => {
  beforeEach(() => {
    cacheMocks.invalidateByPrefix.mockReset();
    cacheMocks.invalidateByPrefix.mockResolvedValue(undefined);
    aiObservabilityMocks.withAiGenerationContext.mockClear();
    vi.mocked(captureException).mockReset();
  });

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
    it("preserves the v1 available response contract", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ key: "calorieGoal", value: 1600 }])
        .mockResolvedValueOnce([{ id: "f1", food_name: "Lunch" }])
        .mockResolvedValueOnce([
          {
            calories: 1000,
            protein_g: 55,
            carbs_g: 105,
            fat_g: 40,
            breakfast_calories: 400,
            lunch_calories: 500,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 100,
            resolution_status: "available",
            resolution_message:
              "Totals use the itemized source; overlapping daily aggregate sources are preserved but excluded.",
            source_providers: ["apple-health", "cronometer"],
            contributing_providers: ["cronometer"],
            excluded_providers: ["apple-health"],
            source_labels: ["apple-health", "cronometer"],
            contributing_source_labels: ["cronometer"],
            excluded_source_labels: ["apple-health"],
            contribution_grain: "itemized",
            contribution_source_label: "cronometer",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDate({ date: "2024-01-15" });

      expect(result).toEqual({
        entries: [{ id: "f1", food_name: "Lunch" }],
        summary: {
          calories: 1000,
          mealCalories: {
            breakfast: 400,
            lunch: 500,
            dinner: 0,
            snack: 0,
            other: 100,
          },
          calorieGoal: {
            target: 1600,
            remaining: 600,
            over: 0,
            progressPercentage: 62.5,
          },
          macros: {
            protein: { grams: 55, calories: 220, energySharePercentage: 22 },
            carbs: { grams: 105, calories: 420, energySharePercentage: 42 },
            fat: { grams: 40, calories: 360, energySharePercentage: 36 },
          },
        },
      });
    });

    it("fails v1 conflicts with an actionable precondition error", async () => {
      const caller = makeConflictCaller();

      await expect(caller.byDate({ date: "2024-01-15" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("keep one contribution set"),
      });
    });

    it("returns entries and explicit conflict metadata from v2", async () => {
      const caller = makeConflictCaller();

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(result.summary).toBeNull();
      expect(result.resolution).toEqual(
        expect.objectContaining({
          status: "source_conflict",
          sourceProviders: ["cronometer", "fatsecret"],
          contributingProviders: [],
        }),
      );
    });

    it("logs when no rows are returned", async () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            calories: 0,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            breakfast_calories: 0,
            lunch_calories: 0,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 0,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: [],
            contributing_providers: [],
            excluded_providers: [],
            source_labels: [],
            contributing_source_labels: [],
            excluded_source_labels: [],
            contribution_grain: null,
            contribution_source_label: null,
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(infoSpy).toHaveBeenCalledWith(
        "[food] byDate returned 0 rows for userId=user-1 date=2024-01-15",
      );
      expect(result).toEqual(
        expect.objectContaining({
          summary: expect.objectContaining({ calories: 0 }),
          resolution: expect.objectContaining({ status: "available" }),
        }),
      );
    });

    it("does not log an aggregate-only day as an empty-data anomaly", async () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            calories: 1800,
            protein_g: 90,
            carbs_g: 220,
            fat_g: 60,
            breakfast_calories: 0,
            lunch_calories: 0,
            dinner_calories: 0,
            snack_calories: 0,
            other_calories: 1800,
            resolution_status: "available",
            resolution_message: "Totals use the only available nutrition source.",
            source_providers: ["apple-health"],
            contributing_providers: ["apple-health"],
            excluded_providers: [],
            source_labels: ["Apple Health"],
            contributing_source_labels: ["Apple Health"],
            excluded_source_labels: [],
            contribution_grain: "daily_aggregate",
            contribution_source_label: "Apple Health",
          },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.byDateV2({ date: "2024-01-15" });

      expect(infoSpy).not.toHaveBeenCalled();
      expect(result.resolution).toMatchObject({
        contributionGrain: "daily_aggregate",
        contributionLabel: "Apple Health daily total",
      });
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
      expect(result).toEqual({ ...created, nutrients: { calories: 200 } });
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

    it("reports cache invalidation errors without failing the delete", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const cacheError = new Error("Redis unavailable");
      cacheMocks.invalidateByPrefix.mockRejectedValueOnce(cacheError);
      const caller = makeCaller([]);

      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toEqual({ success: true });
      expect(captureException).toHaveBeenCalledWith(cacheError);
      expect(warnSpy).toHaveBeenCalledWith(
        "[nutrition] Failed to invalidate nutrition cache for userId=user-1: Error: Redis unavailable",
      );
    });
  });

  describe("analyzeWithAi", () => {
    it("calls AI nutrition analysis", async () => {
      const caller = makeCaller([]);
      const result = await caller.analyzeWithAi({ description: "1 medium apple" });
      expect(result.nutrition).toHaveProperty("foodName", "Apple");
      expect(aiObservabilityMocks.withAiGenerationContext).toHaveBeenCalledWith(
        { userId: "user-1" },
        expect.any(Function),
      );
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
      expect(aiObservabilityMocks.withAiGenerationContext).toHaveBeenCalledWith(
        { userId: "user-1" },
        expect.any(Function),
      );
    });

    it("returns an actionable error when AI cannot parse the meal", async () => {
      const mockedAnalyzeNutritionItems = vi.mocked(analyzeNutritionItems);
      const parseError = new Error("No object generated: response did not match schema.");
      parseError.name = "AI_NoObjectGeneratedError";
      mockedAnalyzeNutritionItems.mockRejectedValueOnce(parseError);

      const caller = makeCaller([]);

      await expect(
        caller.analyzeItemsWithAi({
          description: "p",
        }),
      ).rejects.toThrow("Describe the foods and amounts you want to log.");
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
