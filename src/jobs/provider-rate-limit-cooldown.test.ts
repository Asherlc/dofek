import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryProviderRateLimitCooldownStore,
  providerRateLimitCooldownJobId,
  providerRateLimitDelayMs,
} from "./provider-rate-limit-cooldown.ts";

function rateLimitError(options: {
  providerId: string;
  scope?: "provider" | "user";
  userId?: string | null;
  retryAfterSeconds?: number | null;
}) {
  return new ProviderRateLimitError({
    message: "rate limited",
    providerId: options.providerId,
    statusCode: 429,
    responseBody: "limited",
    scope: options.scope,
    userId: options.userId,
    retryAfterSeconds: options.retryAfterSeconds,
  });
}

describe("ProviderRateLimitCooldownStore", () => {
  it("records provider-wide cooldown state using Retry-After when present", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(cooldown).toEqual({
      providerId: "garmin",
      scope: "provider",
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    });
    await expect(store.getActive("garmin", "user-2")).resolves.toEqual(cooldown);
    vi.useRealTimers();
  });

  it("records user-scoped cooldown state when the rate-limit error requests user scope", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: "user-1",
        retryAfterSeconds: 120,
      }),
      "fallback-user",
    );

    expect(cooldown).toEqual({
      providerId: "fitbit",
      scope: "user",
      userId: "user-1",
      expiresAt: new Date("2026-06-02T12:02:00Z"),
    });
    await expect(store.getActive("fitbit", "user-1")).resolves.toEqual(cooldown);
    await expect(store.getActive("fitbit", "user-2")).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("uses provider fallback cooldown state when Retry-After is absent", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(rateLimitError({ providerId: "strava" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:15:00Z"));
    vi.useRealTimers();
  });

  it("uses provider fallback cooldown state when Retry-After is zero", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 0 }),
      "user-1",
    );

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:30:00Z"));
    vi.useRealTimers();
  });

  it("returns the active cooldown with the later expiry across provider and user scopes", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "fitbit", retryAfterSeconds: 60 }), "user-1");
    const userCooldown = await store.record(
      rateLimitError({ providerId: "fitbit", scope: "user", retryAfterSeconds: 300 }),
      "user-1",
    );

    await expect(store.getActive("fitbit", "user-1")).resolves.toEqual(userCooldown);
    vi.useRealTimers();
  });
});

describe("provider rate-limit scheduling helpers", () => {
  it("computes non-negative delay to a cooldown expiry", () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };

    expect(providerRateLimitDelayMs(cooldown, new Date("2026-06-02T12:00:00Z"))).toBe(600_000);
    expect(providerRateLimitDelayMs(cooldown, new Date("2026-06-02T12:11:00Z"))).toBe(0);
  });

  it("builds stable delayed retry job IDs", () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };

    expect(providerRateLimitCooldownJobId(cooldown, "user-1")).toBe(
      "provider-rate-limit:garmin:provider:user-1:1780402200000",
    );
  });
});
