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
import { analyzeNutrition, analyzeNutritionItems, refineNutritionItems } from "./ai-nutrition.ts";

const mockGenerateText = vi.mocked(generateText);

type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>;

/** Build a mock generateText result with only the `output` field populated */
function mockGenerateTextResult(output: unknown): GenerateTextReturn {
  return { output } as GenerateTextReturn;
}

describe("ai-nutrition — edge cases for coverage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  describe("analyzeNutrition — no output from provider", () => {
    it("throws when provider returns null output", async () => {
      process.env.GEMINI_API_KEY = "test-key";

      mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult(null));

      await expect(analyzeNutrition("a banana")).rejects.toThrow("returned no structured output");
    });
  });

  describe("analyzeNutritionItems — no output from provider", () => {
    it("throws when provider returns null output", async () => {
      process.env.GEMINI_API_KEY = "test-key";

      mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult(null));

      await expect(analyzeNutritionItems("eggs and toast")).rejects.toThrow(
        "returned no structured output",
      );
    });

    it("throws when all providers rate-limited for multi-item analysis", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText
        .mockRejectedValueOnce(new Error("rate limit exceeded"))
        .mockRejectedValueOnce(new Error("resource_exhausted"));

      await expect(analyzeNutritionItems("a banana")).rejects.toThrow(
        "All AI providers rate-limited",
      );
    });

    it("does NOT cascade on non-rate-limit errors for multi-item", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText.mockRejectedValueOnce(new Error("Model not found"));

      await expect(analyzeNutritionItems("food")).rejects.toThrow("Model not found");
      expect(mockGenerateText).toHaveBeenCalledOnce();
    });
  });

  describe("refineNutritionItems — all providers rate-limited", () => {
    it("throws when all providers are rate-limited", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText
        .mockRejectedValueOnce(new Error("quota exceeded"))
        .mockRejectedValueOnce(new Error("429 too many requests"));

      await expect(
        refineNutritionItems(
          [
            {
              foodName: "Egg",
              foodDescription: "1 egg",
              category: "eggs",
              calories: 70,
              proteinG: 6,
              carbsG: 0,
              fatG: 5,
              fiberG: 0,
              saturatedFatG: 1.5,
              sugarG: 0,
              sodiumMg: 70,
              meal: "breakfast",
            },
          ],
          "add toast",
        ),
      ).rejects.toThrow("All AI providers rate-limited");
    });
  });

  describe("isRateLimitError — various error messages", () => {
    it("cascades on 'quota' error messages", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText
        .mockRejectedValueOnce(new Error("Quota exceeded for project"))
        .mockResolvedValueOnce(
          mockGenerateTextResult({
            foodName: "Banana",
            foodDescription: "1 medium",
            category: "fruit",
            calories: 105,
            proteinG: 1.3,
            carbsG: 27,
            fatG: 0.4,
            fiberG: 3.1,
            saturatedFatG: 0.1,
            sugarG: 14,
            sodiumMg: 1,
          }),
        );

      const result = await analyzeNutrition("a banana");
      expect(result.provider).toBe("mistral");
    });

    it("cascades on 'resource_exhausted' error messages", async () => {
      process.env.GEMINI_API_KEY = "test-key";
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText
        .mockRejectedValueOnce(new Error("RESOURCE_EXHAUSTED: out of quota"))
        .mockResolvedValueOnce(
          mockGenerateTextResult({
            foodName: "Apple",
            foodDescription: "1 medium",
            category: "fruit",
            calories: 95,
            proteinG: 0.5,
            carbsG: 25,
            fatG: 0.3,
            fiberG: 4.4,
            saturatedFatG: 0,
            sugarG: 19,
            sodiumMg: 2,
          }),
        );

      const result = await analyzeNutrition("an apple");
      expect(result.provider).toBe("mistral");
    });
  });

  describe("analyzeNutrition — single provider only", () => {
    it("works with only Mistral configured", async () => {
      process.env.MISTRAL_API_KEY = "test-key";

      mockGenerateText.mockResolvedValueOnce(
        mockGenerateTextResult({
          foodName: "Toast",
          foodDescription: "2 slices",
          category: "breads_and_cereals",
          calories: 160,
          proteinG: 5,
          carbsG: 30,
          fatG: 2,
          fiberG: 1,
          saturatedFatG: 0.5,
          sugarG: 3,
          sodiumMg: 280,
        }),
      );

      const result = await analyzeNutrition("two slices of toast");
      expect(result.provider).toBe("mistral");
      expect(result.nutrition.foodName).toBe("Toast");
    });
  });
});
