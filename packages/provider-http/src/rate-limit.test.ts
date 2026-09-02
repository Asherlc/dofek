import { describe, expect, it, vi } from "vitest";
import {
  createRateLimitAwareFetch,
  fetchWithRateLimitHandling,
  isProviderConnectFailure,
  PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
  parseRetryAfterHeader,
} from "./rate-limit.ts";
import type { AdaptiveRateLimitStore } from "./rate-limit-types.ts";

function createMockAdaptiveStore(): AdaptiveRateLimitStore & {
  awaitAdmission: CallableVitestMock;
  recordSuccess: CallableVitestMock;
  recordRateLimit: CallableVitestMock;
  getLearnedCooldownSeconds: CallableVitestMock;
} {
  return {
    awaitAdmission: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordRateLimit: vi.fn().mockResolvedValue(undefined),
    getLearnedCooldownSeconds: vi.fn().mockResolvedValue(null),
  };
}

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

  it("throws a provider service-unavailable error immediately on 503", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    fetchFn.mockResolvedValueOnce(response(503, "service down", "5"));

    const error = await fetchWithRateLimitHandling(
      fetchFn,
      "https://api.example.com/data",
      undefined,
      {
        createRateLimitError: (limitedResponse, body) =>
          new TestRateLimitError(limitedResponse, body),
      },
    ).catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toHaveProperty("providerId", "unknown");
    expect(error).toHaveProperty("statusCode", 503);
    expect(error).toHaveProperty("responseBody", "service down");
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

  it("creates a fetch wrapper that throws the common provider service-unavailable error", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503, "down"));
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "user",
      userId: "user-2",
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toHaveProperty("providerId", "example");
    expect(error).toHaveProperty("statusCode", 503);
    expect(error).toHaveProperty("responseBody", "down");
    expect(error).toHaveProperty("scope", "user");
    expect(error).toHaveProperty("userId", "user-2");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts a provider request at the canonical deadline", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchFn = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected provider request timeout signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "user",
      userId: "user-2",
    });

    const result = rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );
    const timeoutReason = new DOMException("Timed out", "TimeoutError");
    timeoutController.abort(timeoutReason);
    const error = await result;

    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_HTTP_REQUEST_TIMEOUT_MS);
    expect(error).toBeInstanceOf(ProviderRequestTimeoutError);
    expect(error).toHaveProperty("cause", timeoutReason);
    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      providerId: "example",
      scope: "user",
      timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
      userId: "user-2",
    });
  });

  it("preserves caller cancellation instead of reporting a provider timeout", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchFn = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Expected combined provider request signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
    });
    const callerController = new AbortController();
    const callerError = new DOMException("Caller cancelled", "AbortError");

    const result = rateLimitFetch("https://api.example.com/data", {
      signal: callerController.signal,
    }).catch((caughtError: unknown) => caughtError);
    callerController.abort(callerError);

    await expect(result).resolves.toBe(callerError);
  });
  it("treats 502, 503, and 504 as service-unavailable responses", async () => {
    for (const statusCode of [502, 503, 504]) {
      const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(statusCode));
      const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
        providerId: "example",
      });

      const error = await rateLimitFetch("https://api.example.com/data").catch(
        (caughtError: unknown) => caughtError,
      );

      expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
      expect(error).toHaveProperty("statusCode", statusCode);
    }
  });

  it("wraps undici connect timeouts as provider request timeouts (DOFEK-SERVER-4A)", async () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchError = new TypeError("fetch failed", { cause });
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockRejectedValue(fetchError);
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "withings",
    });

    const error = await rateLimitFetch("https://wbsapi.withings.net/measure").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRequestTimeoutError);
    expect(error).toHaveProperty("providerId", "withings");
    expect(isProviderConnectFailure(error)).toBe(true);
  });

  it("returns HTTP 500 by default and classifies opted-in HTTP 500 as unavailable", async () => {
    const defaultFetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(500, "server error"));
    const defaultFetch = createRateLimitAwareFetch(defaultFetchFn, {
      providerId: "example",
    });

    const defaultResponse = await defaultFetch("https://api.example.com/data");

    expect(defaultResponse.status).toBe(500);
    expect(await defaultResponse.text()).toBe("server error");

    const configuredFetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(500, "server error"));
    const configuredFetch = createRateLimitAwareFetch(configuredFetchFn, {
      providerId: "example",
      additionalServiceUnavailableStatusCodes: [500],
    });

    const error = await configuredFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toHaveProperty("statusCode", 500);
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

  it("wraps the same source fetch independently per options (no cross-provider reuse)", async () => {
    // Many providers default to the shared globalThis.fetch; each must get its
    // own wrapper so a 429 reports the correct providerId, not the first caller's.
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));

    const first = createRateLimitAwareFetch(fetchFn, { providerId: "first" });
    const second = createRateLimitAwareFetch(fetchFn, { providerId: "second" });

    const secondError = await second("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );
    expect(secondError).toHaveProperty("providerId", "second");
    expect(first).not.toBe(second);
  });

  it("awaits adaptive admission before calling fetch when a store is provided", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200, "ok"));
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "user",
      userId: "user-9",
      adaptiveStore,
    });

    await rateLimitFetch("https://api.example.com/data");

    expect(adaptiveStore.awaitAdmission).toHaveBeenCalledOnce();
    expect(adaptiveStore.awaitAdmission).toHaveBeenCalledWith("example", "user", "user-9");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("records adaptive success with response headers on ok responses", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "X-RateLimit-Limit": "100,1000" },
      }),
    );
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "provider",
      adaptiveStore,
    });

    await rateLimitFetch("https://api.example.com/data");

    expect(adaptiveStore.recordSuccess).toHaveBeenCalledOnce();
    expect(adaptiveStore.recordSuccess).toHaveBeenCalledWith(
      "example",
      "provider",
      null,
      expect.any(Headers),
    );
  });

  it("does not record adaptive success when the response is not ok", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(404, "missing"));
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      adaptiveStore,
    });

    const result = await rateLimitFetch("https://api.example.com/data");

    expect(result.status).toBe(404);
    expect(adaptiveStore.recordSuccess).not.toHaveBeenCalled();
  });

  it("records adaptive rate limits when a provider rate-limit error is thrown", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      scope: "user",
      userId: "user-9",
      adaptiveStore,
    });

    const error = await rateLimitFetch("https://api.example.com/data").catch(
      (caughtError: unknown) => caughtError,
    );

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(adaptiveStore.recordRateLimit).toHaveBeenCalledOnce();
    expect(adaptiveStore.recordRateLimit).toHaveBeenCalledWith(error);
  });

  it("does not record adaptive rate limits for service-unavailable responses", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503, "down"));
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      adaptiveStore,
    });

    await rateLimitFetch("https://api.example.com/data").catch(() => undefined);

    expect(adaptiveStore.recordRateLimit).not.toHaveBeenCalled();
  });

  it("does not record adaptive rate limits for custom non-provider rate-limit errors", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(429, "limited"));
    const adaptiveStore = createMockAdaptiveStore();
    const rateLimitFetch = createRateLimitAwareFetch(fetchFn, {
      providerId: "example",
      adaptiveStore,
      createRateLimitError: (_response, body) => new Error(`custom ${body}`),
    });

    await rateLimitFetch("https://api.example.com/data").catch(() => undefined);

    expect(adaptiveStore.recordRateLimit).not.toHaveBeenCalled();
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
