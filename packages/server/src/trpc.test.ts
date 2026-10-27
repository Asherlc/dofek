import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { ProviderInvalidCredentialsError } from "dofek/providers/auth-errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CacheTTL,
  type Context,
  cachedProtectedQuery,
  publicProcedure,
  requestCacheKey,
  requestCacheTtl,
  router,
} from "./trpc.ts";

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

const safeInternalErrorMessage =
  "We couldn't complete this request. Please try again. If the problem continues, contact support.";

function testContext(partial: Partial<Context>): Context {
  const context: Context = partial;
  return context;
}

async function serializeTransportError(error: unknown) {
  const observedErrors: TRPCError[] = [];
  const testRouter = router({
    fail: publicProcedure.query(() => "unreachable"),
  });
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request("http://localhost/api/trpc/fail"),
    router: testRouter,
    createContext: () => {
      throw error;
    },
    onError: ({ error: observedError }) => {
      observedErrors.push(observedError);
    },
  });

  return {
    body: await response.text(),
    observedError: observedErrors[0],
    status: response.status,
  };
}

describe("tRPC error serialization", () => {
  it("marks confirmed invalid credentials while preserving their actionable error", async () => {
    const cause = new ProviderInvalidCredentialsError("Zepp");
    const result = await serializeTransportError(
      new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause }),
    );
    const body = JSON.parse(result.body);
    expect(result.status).toBe(400);
    expect(body.error.message).toBe(cause.message);
    expect(body.error.data.handledFailure).toBe("invalid_credentials");
  });

  it("serializes a configuration failure with the feature and support action", async () => {
    const diagnostic = new Error("CLICKHOUSE_URL environment variable is required");
    const testRouter = router({
      running: router({
        dynamicsV2: publicProcedure.query(() => {
          throw diagnostic;
        }),
      }),
    });
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("https://app.example.test/api/trpc/running.dynamicsV2"),
      router: testRouter,
      createContext: () => testContext({ userId: "user-1", timezone: "UTC", sensorStore: {} }),
    });
    expect(response.status).toBe(412);
    const body = await response.json();
    expect(body.error.message).toBe(
      "Running analytics are unavailable because the analytics service is not configured. Contact support.",
    );
    expect(body.error.data.code).toBe("PRECONDITION_FAILED");
    expect(JSON.stringify(body)).not.toContain("CLICKHOUSE_URL");
  });

  it("hides raw SQL and parameters while keeping the original error observable", async () => {
    const databaseError = new Error(
      "Failed query: SELECT user_id FROM fitness.session WHERE id = $1\nparams: private-session",
    );

    const result = await serializeTransportError(databaseError);

    expect(result.status).toBe(500);
    expect(result.body).toContain(safeInternalErrorMessage);
    expect(result.body).not.toContain("SELECT user_id");
    expect(result.body).not.toContain("private-session");
    expect(result.body).not.toContain("params:");
    expect(result.body).toContain('"code":"INTERNAL_SERVER_ERROR"');
    expect(result.body).toContain('"httpStatus":500');
    expect(result.observedError?.cause).toBe(databaseError);
  });

  it("hides Zod issue details from unexpected internal failures", async () => {
    const validationResult = z.uuid().safeParse("rejected-user-id");
    if (validationResult.success) {
      throw new Error("expected the fixture to fail UUID validation");
    }

    const result = await serializeTransportError(validationResult.error);

    expect(result.body).toContain(safeInternalErrorMessage);
    expect(result.body).not.toContain("invalid_format");
    expect(result.body).not.toContain("rejected-user-id");
    expect(result.body).not.toContain("pattern");
    expect(result.observedError?.cause).toBe(validationResult.error);
  });

  it("describes invalid request input without exposing Zod issue details", async () => {
    const validationResult = z.object({ date: z.iso.date() }).safeParse({ date: "tomorrow" });
    if (validationResult.success) {
      throw new Error("expected the fixture to fail date validation");
    }
    const validationError = new TRPCError({
      code: "BAD_REQUEST",
      cause: validationResult.error,
    });

    const result = await serializeTransportError(validationError);

    expect(result.status).toBe(400);
    expect(result.body).toContain("Some information is invalid. Check your entries and try again.");
    expect(result.body).not.toContain("invalid_format");
    expect(result.body).not.toContain("tomorrow");
  });

  it("hides a default internal message even when the error has a cause", async () => {
    const rootCause = new Error("private database failure");
    const defaultError = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "INTERNAL_SERVER_ERROR",
      cause: rootCause,
    });

    const result = await serializeTransportError(defaultError);

    expect(result.body).toContain(safeInternalErrorMessage);
    expect(result.body).not.toContain(rootCause.message);
    expect(result.observedError).toBe(defaultError);
    expect(result.observedError?.cause).toBe(rootCause);
  });

  it("preserves non-internal error messages", async () => {
    const badRequestCause = new Error("Choose a supported date range.");
    const badRequestError = new TRPCError({
      code: "BAD_REQUEST",
      cause: badRequestCause,
    });

    const result = await serializeTransportError(badRequestError);

    expect(result.status).toBe(400);
    expect(result.body).toContain(badRequestCause.message);
    expect(result.body).not.toContain(safeInternalErrorMessage);
    expect(result.observedError).toBe(badRequestError);
    expect(result.observedError?.cause).toBe(badRequestCause);
  });

  it("preserves explicit actionable internal error messages", async () => {
    const rootCause = new Error("private upstream response");
    const explicitError = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The report snapshot could not be created. Please try again.",
      cause: rootCause,
    });

    const result = await serializeTransportError(explicitError);

    expect(result.body).toContain("The report snapshot could not be created. Please try again.");
    expect(result.body).not.toContain(safeInternalErrorMessage);
    expect(result.body).not.toContain(rootCause.message);
    expect(result.observedError).toBe(explicitError);
    expect(result.observedError?.cause).toBe(rootCause);
  });

  it("preserves explicit actionable internal error messages without a cause", async () => {
    const explicitError = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Reconnect your account and try again.",
    });

    const result = await serializeTransportError(explicitError);

    expect(result.body).toContain("Reconnect your account and try again.");
    expect(result.body).not.toContain(safeInternalErrorMessage);
    expect(result.observedError).toBe(explicitError);
  });
});

describe("requestCacheKey", () => {
  it("preserves the exact legacy key when no contract version is provided", () => {
    expect(requestCacheKey("user-1", "settings.get", { key: "units" }, "UTC")).toBe(
      'user-1:settings.get:UTC:{"key":"units"}',
    );
  });

  it("keeps the user and route path prefix stable for invalidation", () => {
    expect(requestCacheKey("user-1", "settings.get", { key: "units" }, "UTC")).toMatch(
      /^user-1:settings\.get:/,
    );
  });

  it("separates cache entries by request timezone", () => {
    const rawInput = { days: 30 };

    expect(requestCacheKey("user-1", "training.rolling", rawInput, "UTC")).not.toBe(
      requestCacheKey("user-1", "training.rolling", rawInput, "America/Los_Angeles"),
    );
  });

  it("separates cache entries by response contract version", () => {
    const rawInput = { endDate: "2026-07-28" };

    expect(
      requestCacheKey(
        "user-1",
        "mobileDashboard.dashboardV2",
        rawInput,
        "UTC",
        "sleep-need-metadata-v1",
      ),
    ).not.toBe(requestCacheKey("user-1", "mobileDashboard.dashboardV2", rawInput, "UTC"));
  });
});

describe("cached query contract versions", () => {
  afterEach(async () => {
    await queryCache.invalidateAll();
  });

  it("bypasses the prior contract key and then hits the versioned cache", async () => {
    const input = { endDate: "2026-07-28" };
    const resolver = vi.fn(() => "fresh-contract");
    const testRouter = router({
      dashboard: cachedProtectedQuery({
        maxAge: CacheTTL.SHORT,
        keyVersion: "sleep-need-metadata-v1",
      })
        .input(z.object({ endDate: z.string() }))
        .query(resolver),
    });
    const legacyKey = requestCacheKey("user-1", "dashboard", input, "UTC");
    await queryCache.set(legacyKey, "legacy-contract", CacheTTL.SHORT);
    const caller = testRouter.createCaller(
      testContext({
        db: {},
        sensorStore: {},
        userId: "user-1",
        timezone: "UTC",
      }),
    );

    await expect(caller.dashboard(input)).resolves.toBe("fresh-contract");
    await expect(caller.dashboard(input)).resolves.toBe("fresh-contract");
    expect(resolver).toHaveBeenCalledOnce();
  });
});

describe("requestCacheTtl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectTtlWithinBoundarySearchPrecision(ttl: number, now: Date, nextBoundary: Date) {
    const expectedTtl = nextBoundary.getTime() - now.getTime();

    expect(ttl).toBeGreaterThanOrEqual(expectedTtl);
    expect(ttl).toBeLessThanOrEqual(expectedTtl + 1000);
  }

  it("keeps the configured TTL when the local day boundary is farther away", () => {
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "UTC",
      new Date("2026-07-08T12:00:00.000Z"),
    );

    expect(ttl).toBe(CacheTTL.LONG);
  });

  it("uses the configured TTL when no semantic expiry is requested", () => {
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG },
      "UTC",
      new Date("2026-07-08T23:45:00.000Z"),
    );

    expect(ttl).toBe(CacheTTL.LONG);
  });

  it("caps the TTL at the next UTC day boundary", () => {
    const now = new Date("2026-07-08T23:45:00.000Z");
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "UTC",
      now,
    );

    expectTtlWithinBoundarySearchPrecision(ttl, now, new Date("2026-07-09T00:00:00.000Z"));
  });

  it("uses the request timezone day boundary", () => {
    const now = new Date("2026-07-09T06:50:00.000Z");
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "America/Los_Angeles",
      now,
    );

    expectTtlWithinBoundarySearchPrecision(ttl, now, new Date("2026-07-09T07:00:00.000Z"));
  });

  it("falls back to the configured TTL for invalid timezones", () => {
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "not-a-timezone",
      new Date("2026-07-08T23:45:00.000Z"),
    );

    expect(ttl).toBe(CacheTTL.LONG);
  });

  it("rethrows unexpected local day boundary calculation errors", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("calendar service unavailable");
    });

    expect(() =>
      requestCacheTtl(
        { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
        "UTC",
        new Date("2026-07-08T23:45:00.000Z"),
      ),
    ).toThrow("calendar service unavailable");
  });
});

describe("schema-aware cached queries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  const outputSchema = z.object({ count: z.number() });
  function typedCaller(resolver: () => unknown) {
    return router({
      typed: cachedProtectedQuery({ maxAge: CacheTTL.SHORT, outputSchema })
        .output(outputSchema)
        .query(resolver),
    }).createCaller(testContext({ userId: "user-1", timezone: "UTC", db: {}, sensorStore: {} }));
  }
  it("parses a valid cached hit without invoking the resolver", async () => {
    const get = vi.spyOn(queryCache, "get").mockResolvedValue({ count: 3, extra: "discarded" });
    const set = vi.spyOn(queryCache, "set").mockResolvedValue(undefined);
    const resolver = vi.fn(() => ({ count: 9 }));
    expect(await typedCaller(resolver).typed()).toEqual({ count: 3 });
    expect(get).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it("reports and evicts malformed cached data then rebuilds through the resolver", async () => {
    vi.spyOn(queryCache, "get").mockResolvedValue({ count: "invalid" });
    const invalidate = vi.spyOn(queryCache, "invalidate").mockResolvedValue(undefined);
    const set = vi.spyOn(queryCache, "set").mockResolvedValue(undefined);
    const resolver = vi.fn(() => ({ count: 7 }));
    expect(await typedCaller(resolver).typed()).toEqual({ count: 7 });
    expect(captureException).toHaveBeenCalledWith(expect.any(z.ZodError));
    expect(invalidate).toHaveBeenCalledWith(requestCacheKey("user-1", "typed", undefined, "UTC"));
    expect(resolver).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      requestCacheKey("user-1", "typed", undefined, "UTC"),
      { count: 7 },
      CacheTTL.SHORT,
    );
  });
  it("validates cache misses before writing data", async () => {
    vi.spyOn(queryCache, "get").mockResolvedValue(undefined);
    const set = vi.spyOn(queryCache, "set").mockResolvedValue(undefined);
    const caller = typedCaller(() => ({ count: "invalid" }));
    await expect(caller.typed()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Output validation failed",
    });
    expect(set).not.toHaveBeenCalled();
  });
  it("caches a valid miss without reporting or evicting it as malformed", async () => {
    vi.spyOn(queryCache, "get").mockResolvedValue(undefined);
    const invalidate = vi.spyOn(queryCache, "invalidate").mockResolvedValue(undefined);
    const set = vi.spyOn(queryCache, "set").mockResolvedValue(undefined);
    const resolver = vi.fn(() => ({ count: 5 }));
    expect(await typedCaller(resolver).typed()).toEqual({ count: 5 });
    expect(resolver).toHaveBeenCalledOnce();
    expect(captureException).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      requestCacheKey("user-1", "typed", undefined, "UTC"),
      { count: 5 },
      CacheTTL.SHORT,
    );
  });
});
