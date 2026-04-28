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

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

/** Build a minimal mock result for generateText — only the `output` field is used by tests. */
function mockResult(output: { items: NutritionItemWithMeal[] }): GenerateTextResult {
  // generateText returns many fields; tests only inspect `output`, so we provide
  // a structurally-typed partial with the correct return type annotation.
  const result: GenerateTextResult = Object.assign(Object.create(null), { output });
  return result;
}

const burrito: NutritionItemWithMeal = {
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
};

const coke: NutritionItemWithMeal = {
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
  caffeineMg: 34,
  meal: "lunch",
};

const sampleItems: NutritionItemWithMeal[] = [burrito, coke];

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

    mockGenerateText.mockResolvedValueOnce(mockResult({ items: sampleItems }));

    const result = await analyzeNutritionItems("chicken burrito and a coke for lunch");

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.foodName).toBe("Chicken Burrito");
    expect(result.items[0]?.meal).toBe("lunch");
    expect(result.items[1]?.foodName).toBe("Coca-Cola");
    expect(result.provider).toBe("gemini");
  });

  it("throws when no providers are configured", async () => {
    await expect(analyzeNutritionItems("a banana")).rejects.toThrow("No AI providers configured");
  });

  it("includes local time in AI system prompt when provided", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(
      mockResult({ items: [{ ...burrito, meal: "breakfast" }] }),
    );

    await analyzeNutritionItems("eggs and toast", "Monday, 7:30 AM");

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).toContain("Monday, 7:30 AM");
  });

  it("asks AI providers for detailed micronutrients including caffeine", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockResult({ items: [coke] }));

    await analyzeNutritionItems("coffee with milk and sugar");

    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).toContain("detailed micronutrients");
    expect(callArgs?.system).toContain("caffeine");
  });

  it("does not include time context when localTime is omitted", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockResult({ items: sampleItems }));

    await analyzeNutritionItems("chicken burrito and a coke");

    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).not.toContain("local time is");
  });

  it("cascades to next provider on rate limit", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce(mockResult({ items: [burrito] }));

    const result = await analyzeNutritionItems("a burrito for lunch");

    expect(result.provider).toBe("mistral");
    expect(result.items).toHaveLength(1);
  });
});
