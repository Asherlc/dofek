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
import { type NutritionItemWithMeal, refineNutritionItems } from "./ai-nutrition.ts";

const mockGenerateText = vi.mocked(generateText);

type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>;

/** Build a mock generateText result with only the `output` field populated */
function mockGenerateTextResult(output: unknown): GenerateTextReturn {
  // @ts-expect-error partial mock — only populating the output field needed by tests
  const result: GenerateTextReturn = { output };
  return result;
}

const previousItems: NutritionItemWithMeal[] = [
  {
    foodName: "Scrambled Eggs",
    foodDescription: "2 large eggs",
    category: "eggs",
    calories: 180,
    proteinG: 12,
    carbsG: 2,
    fatG: 14,
    fiberG: 0,
    saturatedFatG: 4,
    sugarG: 1,
    sodiumMg: 300,
    meal: "breakfast",
  },
  {
    foodName: "Toast",
    foodDescription: "2 slices white bread",
    category: "breads_and_cereals",
    calories: 160,
    proteinG: 5,
    carbsG: 30,
    fatG: 2,
    fiberG: 1,
    saturatedFatG: 0.5,
    sugarG: 3,
    sodiumMg: 280,
    meal: "breakfast",
  },
];

describe("refineNutritionItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  it("throws when no providers are configured", async () => {
    await expect(refineNutritionItems(previousItems, "add butter")).rejects.toThrow(
      "No AI providers configured",
    );
  });

  it("returns refined items from the AI provider", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    const refinedItems: NutritionItemWithMeal[] = [
      ...previousItems,
      {
        foodName: "Butter",
        foodDescription: "1 pat (5g)",
        category: "sauces_spices_and_spreads",
        calories: 36,
        proteinG: 0,
        carbsG: 0,
        fatG: 4,
        fiberG: 0,
        saturatedFatG: 2.5,
        sugarG: 0,
        sodiumMg: 30,
        meal: "breakfast",
      },
    ];

    mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult({ items: refinedItems }));

    const result = await refineNutritionItems(previousItems, "add butter to the toast");

    expect(result.items).toHaveLength(3);
    expect(result.provider).toBe("gemini");
    expect(result.items[2]?.foodName).toBe("Butter");
  });

  it("includes local time in the system prompt when provided", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult({ items: previousItems }));

    await refineNutritionItems(previousItems, "that's all", "Tuesday, 8:15 AM");

    // @ts-expect-error mock call args type is wider than our narrow subset
    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).toContain("Tuesday, 8:15 AM");
  });

  it("does not include local time when not provided", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult({ items: previousItems }));

    await refineNutritionItems(previousItems, "that's correct");

    // @ts-expect-error mock call args type is wider than our narrow subset
    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).not.toContain("local time is");
  });

  it("sends previous items as assistant context in messages", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult({ items: previousItems }));

    await refineNutritionItems(previousItems, "remove the toast");

    // @ts-expect-error mock call args type is wider than our narrow subset
    const callArgs:
      | {
          messages?: Array<{ role: string; content: string }>;
        }
      | undefined = mockGenerateText.mock.calls[0]?.[0];

    expect(callArgs?.messages).toBeDefined();
    expect(callArgs?.messages?.length).toBe(3);

    // Second message (assistant) should contain the previous items summary
    const assistantMsg = callArgs?.messages?.[1];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toContain("Scrambled Eggs");
    expect(assistantMsg?.content).toContain("Toast");

    // Third message (user) should be the refinement text
    const userMsg = callArgs?.messages?.[2];
    expect(userMsg?.role).toBe("user");
    expect(userMsg?.content).toBe("remove the toast");
  });

  it("cascades to next provider on rate limit", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce(mockGenerateTextResult({ items: previousItems }));

    const result = await refineNutritionItems(previousItems, "looks good");

    expect(result.provider).toBe("mistral");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("throws on non-rate-limit errors without cascading", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("Invalid request format"));

    await expect(refineNutritionItems(previousItems, "test")).rejects.toThrow(
      "Invalid request format",
    );
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("throws when provider returns no output", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockGenerateTextResult(null));

    await expect(refineNutritionItems(previousItems, "test")).rejects.toThrow(
      "returned no structured output",
    );
  });
});
