import { describe, expect, it, vi } from "vitest";
import {
  createRateLimitAwareFetch,
  fetchWithRateLimitHandling,
  ProviderRateLimitError,
} from "./rate-limit.ts";

class TestRateLimitError extends ProviderRateLimitError {
  constructor(response: Response, body: string) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
    super({
      message: `limited ${response.status}: ${body}`,
      providerId: "test-provider",
      statusCode: response.status,
      responseBody: body,
      scope: "user",
      userId: "user-1",
      retryAfterSeconds,
    });
    this.name = "TestRateLimitError";
  }
}

function response(status: number, body = "body", retryAfterSeconds?: string): Response {
  return new Response(body, {
    status,
    headers: retryAfterSeconds ? { "Retry-After": retryAfterSeconds } : undefined,
  });
}

describe("fetchWithRateLimitHandling", () => {
  it("returns successful responses without retrying", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    fetchFn.mockResolvedValueOnce(response(200, "ok"));

    const result = await fetchWithRateLimitHandling(
      fetchFn,
      "https://api.example.com/data",
      undefined,
      {
        createRateLimitError: (limitedResponse, body) =>
          new TestRateLimitError(limitedResponse, body),
      },
    );

    expect(result.status).toBe(200);
    expect(await result.text()).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws a provider rate-limit error immediately on 429", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    fetchFn.mockResolvedValueOnce(response(429, "limited", "5"));

    const error = await fetchWithRateLimitHandling(
      fetchFn,
      "https://api.example.com/data",
      undefined,
      {
        createRateLimitError: (limitedResponse, body) =>
          new TestRateLimitError(limitedResponse, body),
      },
    ).catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(TestRateLimitError);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("message", "limited 429: limited");
    expect(error).toHaveProperty("providerId", "test-provider");
    expect(error).toHaveProperty("statusCode", 429);
    expect(error).toHaveProperty("responseBody", "limited");
    expect(error).toHaveProperty("scope", "user");
    expect(error).toHaveProperty("userId", "user-1");
    expect(error).toHaveProperty("retryAfterSeconds", 5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("creates a fetch wrapper that throws the common provider rate-limit error by default", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "user",
      userId: "user-2",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("providerId", "example");
    expect(error).toHaveProperty("statusCode", 429);
    expect(error).toHaveProperty("responseBody", "limited");
    expect(error).toHaveProperty("scope", "user");
    expect(error).toHaveProperty("userId", "user-2");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
