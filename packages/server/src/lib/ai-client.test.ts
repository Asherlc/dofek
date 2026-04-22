import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "google-model")),
}));

vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => vi.fn(() => "mistral-model")),
}));

import {
  getConfiguredAiProviders,
  isRetryableProviderError,
  runWithProviderFallback,
} from "./ai-client.ts";

describe("getConfiguredAiProviders", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  it("returns providers in priority order: gemini then mistral", () => {
    process.env.MISTRAL_API_KEY = "mistral-key";
    process.env.GEMINI_API_KEY = "gemini-key";

    const providers = getConfiguredAiProviders();

    expect(providers.map((provider) => provider.name)).toEqual(["gemini", "mistral"]);
  });

  it("returns empty array when no provider keys are configured", () => {
    const providers = getConfiguredAiProviders();
    expect(providers).toHaveLength(0);
  });
});

describe("isRetryableProviderError", () => {
  it("matches common transient capacity and quota errors", () => {
    expect(isRetryableProviderError(new Error("429 too many requests"))).toBe(true);
    expect(isRetryableProviderError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isRetryableProviderError(new Error("currently experiencing high demand"))).toBe(true);
  });

  it("does not match non-transient errors", () => {
    expect(isRetryableProviderError(new Error("invalid api key"))).toBe(false);
    expect(isRetryableProviderError("429")).toBe(false);
  });
});

describe("runWithProviderFallback", () => {
  const providers = [
    { name: "provider-a", createModel: vi.fn() },
    { name: "provider-b", createModel: vi.fn() },
  ];

  it("throws a clear error when providers are not configured", async () => {
    await expect(
      runWithProviderFallback({
        providers: [],
        runForProvider: async () => "never",
      }),
    ).rejects.toThrow("No AI providers configured");
  });

  it("falls through on retryable errors and returns first successful provider", async () => {
    const runForProvider = vi
      .fn<(provider: (typeof providers)[number]) => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce("ok");

    const result = await runWithProviderFallback({
      providers,
      runForProvider,
    });

    expect(result.provider).toBe("provider-b");
    expect(result.output).toBe("ok");
    expect(runForProvider).toHaveBeenCalledTimes(2);
  });

  it("does not continue after non-retryable errors", async () => {
    const runForProvider = vi
      .fn<(provider: (typeof providers)[number]) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Invalid API key"));

    await expect(
      runWithProviderFallback({
        providers,
        runForProvider,
      }),
    ).rejects.toThrow("Invalid API key");

    expect(runForProvider).toHaveBeenCalledTimes(1);
  });
});
