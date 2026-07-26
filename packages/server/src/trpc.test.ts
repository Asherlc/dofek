import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CacheTTL, publicProcedure, requestCacheKey, requestCacheTtl, router } from "./trpc.ts";

const safeInternalErrorMessage =
  "We couldn't complete this request. Please try again. If the problem continues, contact support.";

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
});

describe("requestCacheKey", () => {
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
