import { describe, expect, it, vi } from "vitest";
import {
  createRateLimitAwareFetch,
  fetchWithRateLimitHandling,
  ProviderRateLimitError,
  parseRetryAfterHeader,
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
    expect(fetchFn).toHaveBeenCalledWith("https://api.example.com/data");
  });

  it("passes request init through to the underlying fetch", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    fetchFn.mockResolvedValueOnce(response(201, "created"));
    const init: RequestInit = {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: "payload",
    };

    const result = await fetchWithRateLimitHandling(fetchFn, "https://api.example.com/data", init, {
      createRateLimitError: (limitedResponse, body) =>
        new TestRateLimitError(limitedResponse, body),
    });

    expect(result.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledWith("https://api.example.com/data", init);
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

  it("stores explicit provider rate-limit error options", () => {
    const error = new ProviderRateLimitError({
      message: "limited",
      providerId: "example",
      statusCode: 429,
      responseBody: "body",
      scope: "user",
      userId: "user-1",
      retryAfterSeconds: 30,
    });

    expect(error.name).toBe("ProviderRateLimitError");
    expect(error.message).toBe("limited");
    expect(error.providerId).toBe("example");
    expect(error.statusCode).toBe(429);
    expect(error.responseBody).toBe("body");
    expect(error.scope).toBe("user");
    expect(error.userId).toBe("user-1");
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("defaults missing provider rate-limit error options", () => {
    const error = new ProviderRateLimitError({
      message: "limited",
      providerId: "example",
      statusCode: 429,
      responseBody: "body",
    });

    expect(error.scope).toBe("provider");
    expect(error.userId).toBeNull();
    expect(error.retryAfterSeconds).toBeNull();
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

  it("uses provider scope and null user by default in wrapper errors", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("scope", "provider");
    expect(error).toHaveProperty("userId", null);
    expect(error).toHaveProperty("retryAfterSeconds", null);
  });

  it("parses Retry-After dates in default wrapper errors", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "Tue, 02 Jun 2026 12:00:05 GMT" },
      }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 5);
    vi.useRealTimers();
  });

  it("parses numeric Retry-After seconds in default wrapper errors", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "5" },
      }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 5);
  });

  it("accepts a zero-second Retry-After header in default wrapper errors", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 0);
  });

  it("clamps past Retry-After dates to zero seconds", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "Tue, 02 Jun 2026 11:59:59 GMT" },
      }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 0);
    vi.useRealTimers();
  });

  it("ignores invalid Retry-After values in default wrapper errors", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "not a retry date" },
      }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", null);
  });

  it("uses a custom wrapper rate-limit error factory when provided", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));
    const createRateLimitError = vi.fn((limitedResponse: Response, body: string) => {
      return new TestRateLimitError(limitedResponse, body);
    });
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      createRateLimitError,
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(TestRateLimitError);
    expect(createRateLimitError).toHaveBeenCalledOnce();
    expect(createRateLimitError).toHaveBeenCalledWith(expect.any(Response), "limited");
  });

  it("does not wrap an already rate-limit-aware fetch twice", () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, "ok"));
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });

    const wrappedAgain = createRateLimitAwareFetch(rateLimitFetch, {
      providerId: "example",
    });

    expect(wrappedAgain).toBe(rateLimitFetch);
  });

  it("returns the same wrapper when wrapping the same source fetch twice", () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, "ok"));

    const first = createRateLimitAwareFetch(fetchFn, { providerId: "example" });
    const second = createRateLimitAwareFetch(fetchFn, { providerId: "example" });

    expect(second).toBe(first);
  });
});

describe("parseRetryAfterHeader", () => {
  it("parses numeric seconds", () => {
    expect(parseRetryAfterHeader("5")).toBe(5);
  });

  it("accepts zero seconds", () => {
    expect(parseRetryAfterHeader("0")).toBe(0);
  });

  it("parses an HTTP-date into seconds", () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    expect(parseRetryAfterHeader("Tue, 02 Jun 2026 12:00:05 GMT")).toBe(5);
    vi.useRealTimers();
  });

  it("clamps past HTTP-dates to zero", () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    expect(parseRetryAfterHeader("Tue, 02 Jun 2026 11:59:59 GMT")).toBe(0);
    vi.useRealTimers();
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader(undefined)).toBeNull();
    expect(parseRetryAfterHeader("not a retry date")).toBeNull();
  });
});
