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

vi.mock("@ai-sdk/groq", () => ({
  createGroq: vi.fn(() => vi.fn(() => "groq-model")),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => vi.fn(() => "mistral-model")),
}));

import { generateText } from "ai";
import { type AiNutritionResult, aiNutritionSchema, analyzeNutrition } from "./ai-nutrition.ts";

const mockGenerateText = vi.mocked(generateText);

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
};

function mockSuccessResponse() {
  return { output: sampleResult } as unknown as Awaited<ReturnType<typeof generateText>>;
}

describe("analyzeNutrition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
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

  it("cascades to next provider on rate limit error", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("429 Too Many Requests: rate limit exceeded"))
      .mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("groq");
    expect(result.nutrition).toEqual(sampleResult);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("cascades through all providers if all rate-limited except last", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockRejectedValueOnce(new Error("resource_exhausted"))
      .mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("mistral");
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });

  it("throws when all providers are rate-limited", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockRejectedValueOnce(new Error("429 too many requests"));

    await expect(analyzeNutrition("a banana")).rejects.toThrow("All AI providers rate-limited");
  });

  it("does NOT cascade on non-rate-limit errors", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("Invalid API key"));

    await expect(analyzeNutrition("a banana")).rejects.toThrow("Invalid API key");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("respects provider priority order: gemini → groq → mistral", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GROQ_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("gemini");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("skips providers without API keys", async () => {
    process.env.GROQ_API_KEY = "test-key";

    mockGenerateText.mockResolvedValueOnce(mockSuccessResponse());

    const result = await analyzeNutrition("a banana");

    expect(result.provider).toBe("groq");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });
});

describe("aiNutritionSchema", () => {
  it("validates a correct nutrition result", () => {
    const result = aiNutritionSchema.safeParse(sampleResult);
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
