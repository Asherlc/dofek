import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheTTL, requestCacheKey, requestCacheTtl } from "./trpc.ts";

describe("requestCacheKey", () => {
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
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "UTC",
      new Date("2026-07-08T23:45:00.000Z"),
    );

    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
  });

  it("uses the request timezone day boundary", () => {
    const ttl = requestCacheTtl(
      { maxAge: CacheTTL.LONG, expiresAt: "localDayBoundary" },
      "America/Los_Angeles",
      new Date("2026-07-09T06:50:00.000Z"),
    );

    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
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
