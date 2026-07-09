import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheTTL, requestCacheKey, requestCacheTtl } from "./trpc.ts";

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
