import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK before importing our module
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
import { type AiNutritionResult, aiNutritionSchema, analyzeNutrition } from "./ai-nutrition.ts";

const mockGenerateText = vi.mocked(generateText);

type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>;

/** Build a mock generateText result with only the `output` field populated */
function mockGenerateTextResult(output: unknown): GenerateTextReturn {
  const result: GenerateTextReturn = { output };
  return result;
}

const sampleResult: AiNutritionResult = {
  foodName: "Roasted Vegetables",
  foodDescription: "1 large plate, roughly 400g mixed vegetables",
  category: "vegetables",
  calories: 250,
  proteinG: 6.5,
  carbsG: 35.2,
  fatG: 10.8,
  fiberG: 8.4,
  saturatedFatG: 1.5,
  sugarG: 12.3,
  sodiumMg: 320,
  caffeineMg: 0,
};

function mockSuccessResponse() {
  return mockGenerateTextResult(sampleResult);
}

describe("analyzeNutrition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  it("throws when no providers are configured", async () => {
    await expect(analyzeNutrition("a banana")).rejects.toThrow("No AI providers configured");
  });

  it("returns nutrition data from the first available provider", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a big plate of roasted vegetables");

    expect(result.provider).toBe("gemini");
    expect(result.nutrition.foodName).toBe("Roasted Vegetables");
    expect(result.nutrition.calories).toBe(250);
    expect(result.nutrition.proteinG).toBe(6.5);
    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a big plate of roasted vegetables",
      }),
    );
  });

  it("asks AI providers for detailed micronutrients including caffeine", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    await analyzeNutrition("a large cold brew");

    const callArgs: { system?: string } | undefined = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs?.system).toContain("detailed micronutrients");
    expect(callArgs?.system).toContain("caffeine");
  });

  it("cascades to next provider on rate limit error", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("429 Too Many Requests: rate limit exceeded"))
      .mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("mistral");
    expect(result.nutrition).toEqual(sampleResult);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("cascades to next provider on high-demand unavailable errors", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(
        new Error(
          "Failed after 3 attempts. Last error: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
        ),
      )
      .mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("mistral");
    expect(result.nutrition).toEqual(sampleResult);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("throws when all providers are rate-limited", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockRejectedValueOnce(new Error("429 too many requests"));

    await expect(analyzeNutrition("a banana")).rejects.toThrow("All AI providers rate-limited");
  });

  it("does NOT cascade on non-rate-limit errors", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("Invalid API key"));

    await expect(analyzeNutrition("a banana")).rejects.toThrow("Invalid API key");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("respects provider priority order: gemini → mistral", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("gemini");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("skips providers without API keys", async () => {
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("mistral");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });
});

describe("aiNutritionSchema", () => {
  it("validates a correct nutrition result", () => {
    const result = aiNutritionSchema.safeParse(sampleResult);
    expect(result.success).toBe(true);
  });

  it("accepts caffeine in milligrams", () => {
    const result = aiNutritionSchema.safeParse({ ...sampleResult, caffeineMg: 95 });
    expect(result.success).toBe(true);
  });

  it("rejects negative calorie values", () => {
    const result = aiNutritionSchema.safeParse({ ...sampleResult, calories: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer calories", () => {
    const result = aiNutritionSchema.safeParse({ ...sampleResult, calories: 250.5 });
    expect(result.success).toBe(false);
  });

  it("requires all fields", () => {
    const result = aiNutritionSchema.safeParse({ foodName: "test" });
    expect(result.success).toBe(false);
  });
});
