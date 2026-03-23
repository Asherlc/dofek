import { describe, expect, it, vi } from "vitest";

// Mock the AI SDK providers before importing the module
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() =>
    vi.fn(() => ({ provider: "google", modelId: "gemini-2.5-flash" })),
  ),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() =>
    vi.fn(() => ({ provider: "mistral", modelId: "mistral-small-latest" })),
  ),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }: { schema: unknown }) => ({ schema })),
  },
}));

import { generateText } from "ai";
import { buildDailyOutlookPrompt, type CoachContext } from "./ai-coach.ts";

const mockGenerateText = vi.mocked(generateText);

describe("buildDailyOutlookPrompt", () => {
  it("includes sleep data when available", () => {
    const context: CoachContext = {
      sleepHours: 7.5,
      sleepScore: 85,
      restingHr: 55,
      hrv: 48,
      strain: 12.5,
      readiness: 72,
      recentActivities: ["Running 45min", "Cycling 60min"],
    };

    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("7.5");
    expect(prompt).toContain("Sleep");
    expect(prompt).toContain("55");
    expect(prompt).toContain("Running 45min");
  });

  it("handles missing optional data", () => {
    const context: CoachContext = {};

    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toBeTruthy();
    // Should still produce a valid prompt even with no data
    expect(prompt.length).toBeGreaterThan(10);
  });
});

describe("generateDailyOutlook", () => {
  it("returns structured output from AI provider", async () => {
    // Import after mocks are set up
    const { generateDailyOutlook } = await import("./ai-coach.ts");

    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue({
      output: {
        summary: "You slept well last night.",
        recommendations: ["Take it easy today", "Hydrate well"],
        focusArea: "recovery",
      },
      text: "",
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      response: {
        id: "test",
        timestamp: new Date(),
        modelId: "gemini-2.5-flash",
        headers: {},
        body: undefined,
      },
      reasoning: undefined,
      reasoningDetails: [],
      sources: [],
      files: [],
      experimental_providerMetadata: undefined,
      providerMetadata: undefined,
      request: { body: "" },
      warnings: [],
      steps: [],
      toolCalls: [],
      toolResults: [],
      logprobs: undefined,
      experimental_output: undefined,
    });

    const result = await generateDailyOutlook({
      sleepHours: 7,
      readiness: 65,
    });

    expect(result.outlook).toBeDefined();
    expect(result.provider).toBe("gemini");

    delete process.env.GEMINI_API_KEY;
  });
});
