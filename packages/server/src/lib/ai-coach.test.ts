import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { z } from "zod";
import {
  buildDailyOutlookPrompt,
  type CoachContext,
  type CoachMessage,
  dailyOutlookSchema,
} from "./ai-coach.ts";

const mockGenerateText = vi.mocked(generateText);

const makeGenerateTextResult = (overrides: Record<string, unknown> = {}) => ({
  text: "",
  finishReason: "stop" as const,
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
  output: null,
  ...overrides,
});

describe("buildDailyOutlookPrompt", () => {
  it("includes sleep hours when provided", () => {
    const context: CoachContext = { sleepHours: 7.5 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("7.5 hours");
    expect(prompt).toContain("Sleep");
  });

  it("includes sleep score when provided", () => {
    const context: CoachContext = { sleepScore: 85 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("85");
    expect(prompt).toContain("Sleep score");
    expect(prompt).toContain("/100");
  });

  it("includes resting heart rate when provided", () => {
    const context: CoachContext = { restingHr: 55 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("55 bpm");
    expect(prompt).toContain("Resting heart rate");
  });

  it("includes HRV when provided", () => {
    const context: CoachContext = { hrv: 48 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("48 ms");
    expect(prompt).toContain("Heart rate variability");
  });

  it("includes strain when provided", () => {
    const context: CoachContext = { strain: 12.5 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("12.5");
    expect(prompt).toContain("strain");
    expect(prompt).toContain("/21");
  });

  it("includes readiness score when provided", () => {
    const context: CoachContext = { readiness: 72 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("72");
    expect(prompt).toContain("Readiness");
    expect(prompt).toContain("/100");
  });

  it("includes recent activities when provided", () => {
    const context: CoachContext = {
      recentActivities: ["Running 45min", "Cycling 60min"],
    };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("Running 45min");
    expect(prompt).toContain("Cycling 60min");
    expect(prompt).toContain("Recent activities");
  });

  it("does not include activities section when array is empty", () => {
    const context: CoachContext = { recentActivities: [] };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).not.toContain("Recent activities");
  });

  it("includes goals when provided", () => {
    const context: CoachContext = { goals: "Run a marathon" };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("Run a marathon");
    expect(prompt).toContain("goals");
  });

  it("adds general wellness fallback when no metrics are available", () => {
    const context: CoachContext = {};
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("No specific metrics available");
    expect(prompt).toContain("general wellness");
  });

  it("does not add general fallback when at least one metric is provided", () => {
    const context: CoachContext = { sleepHours: 7 };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).not.toContain("No specific metrics available");
  });

  it("always ends with the focus question", () => {
    const prompt1 = buildDailyOutlookPrompt({});
    const prompt2 = buildDailyOutlookPrompt({ sleepHours: 7, hrv: 50, restingHr: 55 });
    expect(prompt1).toContain("What should I focus on today?");
    expect(prompt2).toContain("What should I focus on today?");
  });

  it("always starts with the header line", () => {
    const prompt = buildDailyOutlookPrompt({ sleepHours: 8 });
    expect(prompt.startsWith("Here are my current health metrics:")).toBe(true);
  });

  it("includes all provided fields together", () => {
    const context: CoachContext = {
      sleepHours: 7.5,
      sleepScore: 85,
      restingHr: 55,
      hrv: 48,
      strain: 12.5,
      readiness: 72,
      recentActivities: ["Running 45min"],
      goals: "Lose weight",
    };
    const prompt = buildDailyOutlookPrompt(context);
    expect(prompt).toContain("7.5");
    expect(prompt).toContain("85");
    expect(prompt).toContain("55");
    expect(prompt).toContain("48");
    expect(prompt).toContain("12.5");
    expect(prompt).toContain("72");
    expect(prompt).toContain("Running 45min");
    expect(prompt).toContain("Lose weight");
  });

  it("joins parts with newlines", () => {
    const context: CoachContext = { sleepHours: 7, hrv: 50 };
    const prompt = buildDailyOutlookPrompt(context);
    const lines = prompt.split("\n");
    expect(lines.length).toBeGreaterThan(2);
  });
});

describe("dailyOutlookSchema", () => {
  it("accepts valid daily outlook data", () => {
    const result = dailyOutlookSchema.safeParse({
      summary: "You slept well.",
      recommendations: ["Hydrate"],
      focusArea: "recovery",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing summary", () => {
    const result = dailyOutlookSchema.safeParse({
      recommendations: ["Hydrate"],
      focusArea: "recovery",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty recommendations array", () => {
    const result = dailyOutlookSchema.safeParse({
      summary: "Good",
      recommendations: [],
      focusArea: "recovery",
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 5 recommendations", () => {
    const result = dailyOutlookSchema.safeParse({
      summary: "Good",
      recommendations: ["a", "b", "c", "d", "e", "f"],
      focusArea: "recovery",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid focusArea", () => {
    const result = dailyOutlookSchema.safeParse({
      summary: "Good",
      recommendations: ["Hydrate"],
      focusArea: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid focusArea values", () => {
    for (const area of ["training", "recovery", "sleep", "nutrition", "stress-management"]) {
      const result = dailyOutlookSchema.safeParse({
        summary: "Good",
        recommendations: ["Hydrate"],
        focusArea: area,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("generateDailyOutlook", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    if (savedEnv.GEMINI_API_KEY !== undefined) {
      process.env.GEMINI_API_KEY = savedEnv.GEMINI_API_KEY;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (savedEnv.MISTRAL_API_KEY !== undefined) {
      process.env.MISTRAL_API_KEY = savedEnv.MISTRAL_API_KEY;
    } else {
      delete process.env.MISTRAL_API_KEY;
    }
  });

  it("returns structured output from AI provider", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue(
      makeGenerateTextResult({
        output: {
          summary: "You slept well last night.",
          recommendations: ["Take it easy today", "Hydrate well"],
          focusArea: "recovery",
        },
      }),
    );

    const result = await generateDailyOutlook({ sleepHours: 7, readiness: 65 });
    expect(result.outlook).toBeDefined();
    expect(result.outlook.summary).toBe("You slept well last night.");
    expect(result.outlook.recommendations).toEqual(["Take it easy today", "Hydrate well"]);
    expect(result.outlook.focusArea).toBe("recovery");
    expect(result.provider).toBe("gemini");
  });

  it("throws when no AI providers are configured", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    // No API keys set
    await expect(generateDailyOutlook({})).rejects.toThrow("No AI providers configured");
  });

  it("throws when provider returns no structured output", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue(makeGenerateTextResult({ output: null }));

    await expect(generateDailyOutlook({})).rejects.toThrow("returned no structured output");
  });

  it("cascades to next provider on rate limit error", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("rate limit exceeded")).mockResolvedValueOnce(
      makeGenerateTextResult({
        output: {
          summary: "From Mistral.",
          recommendations: ["Rest"],
          focusArea: "recovery",
        },
      }),
    );

    const result = await generateDailyOutlook({ sleepHours: 6 });
    expect(result.provider).toBe("mistral");
    expect(result.outlook.summary).toBe("From Mistral.");
  });

  it("throws non-rate-limit errors immediately without cascading", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("network timeout"));

    await expect(generateDailyOutlook({})).rejects.toThrow("network timeout");
    // Should only have been called once (no cascade for non-rate-limit errors)
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("throws when all providers are rate-limited", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockRejectedValueOnce(new Error("429 too many requests"));

    await expect(generateDailyOutlook({})).rejects.toThrow("All AI providers rate-limited");
  });

  it("includes last error message when all providers rate-limited", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(generateDailyOutlook({})).rejects.toThrow("quota exceeded");
  });
});

describe("chatWithCoach", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    if (savedEnv.GEMINI_API_KEY !== undefined) {
      process.env.GEMINI_API_KEY = savedEnv.GEMINI_API_KEY;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (savedEnv.MISTRAL_API_KEY !== undefined) {
      process.env.MISTRAL_API_KEY = savedEnv.MISTRAL_API_KEY;
    } else {
      delete process.env.MISTRAL_API_KEY;
    }
  });

  it("returns a response from the AI coach", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue(
      makeGenerateTextResult({ text: "Rest today, you earned it." }),
    );

    const messages: CoachMessage[] = [{ role: "user", content: "Should I work out?" }];
    const result = await chatWithCoach(messages, { readiness: 40 });

    expect(result.response).toBe("Rest today, you earned it.");
    expect(result.provider).toBe("gemini");
  });

  it("throws when no providers are configured", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");

    await expect(chatWithCoach([{ role: "user", content: "Hi" }], {})).rejects.toThrow(
      "No AI providers configured",
    );
  });

  it("cascades to next provider on rate limit during chat", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("too many requests"))
      .mockResolvedValueOnce(makeGenerateTextResult({ text: "Mistral response." }));

    const result = await chatWithCoach([{ role: "user", content: "Hi" }], {});
    expect(result.provider).toBe("mistral");
    expect(result.response).toBe("Mistral response.");
  });

  it("throws non-rate-limit errors immediately for chat", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error("invalid auth"));

    await expect(chatWithCoach([{ role: "user", content: "Hi" }], {})).rejects.toThrow(
      "invalid auth",
    );
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("throws when all chat providers are rate-limited", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText
      .mockRejectedValueOnce(new Error("resource_exhausted"))
      .mockRejectedValueOnce(new Error("quota limit"));

    await expect(chatWithCoach([{ role: "user", content: "Hi" }], {})).rejects.toThrow(
      "All AI providers rate-limited",
    );
  });

  it("passes context data to the system prompt", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue(makeGenerateTextResult({ text: "OK" }));

    await chatWithCoach([{ role: "user", content: "Hi" }], {
      sleepHours: 8,
      hrv: 55,
      restingHr: 52,
    });

    const callArgs = mockGenerateText.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    // System prompt should contain the context summary
    const system = z.object({ system: z.string() }).parse(callArgs).system;
    expect(system).toContain("8 hours");
    expect(system).toContain("55 ms");
    expect(system).toContain("52 bpm");
  });

  it("passes user messages to generateText", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    mockGenerateText.mockResolvedValue(makeGenerateTextResult({ text: "OK" }));

    const messages: CoachMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What should I do?" },
    ];

    await chatWithCoach(messages, {});

    const callArgs = mockGenerateText.mock.calls[0]?.[0];
    const messagesSchema = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
    });
    const parsed = messagesSchema.parse(callArgs);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.content).toBe("Hello");
    expect(parsed.messages[2]?.content).toBe("What should I do?");
  });
});

describe("isRateLimitError detection", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    if (savedEnv.GEMINI_API_KEY !== undefined) {
      process.env.GEMINI_API_KEY = savedEnv.GEMINI_API_KEY;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (savedEnv.MISTRAL_API_KEY !== undefined) {
      process.env.MISTRAL_API_KEY = savedEnv.MISTRAL_API_KEY;
    } else {
      delete process.env.MISTRAL_API_KEY;
    }
  });

  it.each([
    "rate limit exceeded",
    "quota exceeded",
    "HTTP 429",
    "too many requests please slow down",
    "resource_exhausted",
    "RATE LIMIT",
    "Quota limit reached",
  ])("detects rate limit error: %s", async (message) => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    mockGenerateText.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(
      makeGenerateTextResult({
        output: {
          summary: "OK",
          recommendations: ["Rest"],
          focusArea: "recovery",
        },
      }),
    );

    // If it cascades to the second provider, the rate limit was detected
    const result = await generateDailyOutlook({});
    expect(result.provider).toBe("mistral");
  });

  it("does not treat non-Error objects as rate limit errors", async () => {
    const { generateDailyOutlook } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";
    process.env.MISTRAL_API_KEY = "test-key";

    // Throw a string (non-Error) — should not be detected as rate limit
    mockGenerateText.mockRejectedValueOnce("rate limit");

    // Non-Error objects are not rate limit errors, so it should throw immediately
    await expect(generateDailyOutlook({})).rejects.toBe("rate limit");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("includes last error as string if not Error instance when all rate-limited", async () => {
    const { chatWithCoach } = await import("./ai-coach.ts");
    process.env.GEMINI_API_KEY = "test-key";

    // Single provider, rate limit error
    mockGenerateText.mockRejectedValueOnce(new Error("rate limit"));

    await expect(chatWithCoach([{ role: "user", content: "Hi" }], {})).rejects.toThrow(
      "All AI providers rate-limited",
    );
  });
});
