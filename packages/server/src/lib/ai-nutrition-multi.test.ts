import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }: { schema: unknown }) => ({ type: "object", schema })),
  },
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "google-model")),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => vi.fn(() => "mistral-model")),
}));

import { generateText } from "ai";
import { analyzeNutritionItems, type NutritionItemWithMeal } from "./ai-nutrition.ts";

const mockGenerateText = vi.mocked(generateText);

const sampleItems: NutritionItemWithMeal[] = [
  {
    foodName: "Chicken Burrito",
    foodDescription: "1 large burrito",
    category: "fast_food",
    calories: 650,
    proteinG: 35,
    carbsG: 72,
    fatG: 22,
    fiberG: 8,
    saturatedFatG: 8,
    sugarG: 3,
    sodiumMg: 1200,
    meal: "lunch",
  },
  {
    foodName: "Coca-Cola",
    foodDescription: "1 can (355ml)",
    category: "beverages",
    calories: 140,
    proteinG: 0,
    carbsG: 39,
    fatG: 0,
    fiberG: 0,
    saturatedFatG: 0,
    sugarG: 39,
    sodiumMg: 45,
    meal: "lunch",
  },
];

describe("analyzeNutritionItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  it("returns multiple food items from a single description", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce({
      output: { items: sampleItems },
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const result = await analyzeNutritionItems("chicken burrito and a coke for lunch");

    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.foodName).toBe("Chicken Burrito");
    expect(result.items[0]!.meal).toBe("lunch");
    expect(result.items[1]!.foodName).toBe("Coca-Cola");
    expect(result.provider).toBe("gemini");
  });

  it("throws when no providers are configured", async () => {
    await expect(analyzeNutritionItems("a banana")).rejects.toThrow("No AI providers configured");
  });

  it("cascades to next provider on rate limit", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({
        output: { items: [sampleItems[0]] },
      } as unknown as Awaited<ReturnType<typeof generateText>>);

    const result = await analyzeNutritionItems("a burrito for lunch");

    expect(result.provider).toBe("mistral");
    expect(result.items).toHaveLength(1);
  });
});
