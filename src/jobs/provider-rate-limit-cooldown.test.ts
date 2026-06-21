import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryProviderRateLimitCooldownStore,
  providerRateLimitCooldownJobId,
  providerRateLimitDelayMs,
  RedisProviderRateLimitCooldownStore,
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

function createMockRedisStore() {
  const values = new Map<string, string>();
  const setCalls: Array<{
    key: string;
    value: string;
    mode: "PX";
    millisecondsToExpire: number;
  }> = [];
  const getRedisClient: ConstructorParameters<typeof RedisProviderRateLimitCooldownStore>[0] =
    async () => ({
      set: async (key, value, mode, millisecondsToExpire) => {
        setCalls.push({ key, value, mode, millisecondsToExpire });
        values.set(key, value);
        return "OK";
      },
      get: async (key) => values.get(key) ?? null,
    });

  return {
    values,
    setCalls,
    store: new RedisProviderRateLimitCooldownStore(getRedisClient),
  };
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
      consecutiveHits: 1,
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
      consecutiveHits: 1,
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

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T13:00:00Z"));
    vi.useRealTimers();
  });

  it("escalates Garmin cooldown duration on consecutive rate-limit hits", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const first = await store.record(rateLimitError({ providerId: "garmin" }), "user-1");
    expect(first.consecutiveHits).toBe(1);
    expect(first.expiresAt).toEqual(new Date("2026-06-02T13:00:00Z"));

    vi.setSystemTime(new Date("2026-06-02T13:00:00Z"));
    const second = await store.record(rateLimitError({ providerId: "garmin" }), "user-1");
    expect(second.consecutiveHits).toBe(2);
    expect(second.expiresAt).toEqual(new Date("2026-06-02T15:00:00Z"));
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

  it("returns provider cooldown state when it expires after user-scoped state", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const providerCooldown = await store.record(
      rateLimitError({ providerId: "fitbit", retryAfterSeconds: 300 }),
      "user-1",
    );
    await store.record(
      rateLimitError({ providerId: "fitbit", scope: "user", retryAfterSeconds: 60 }),
      "user-1",
    );

    await expect(store.getActive("fitbit", "user-1")).resolves.toEqual(providerCooldown);
    vi.useRealTimers();
  });

  it("keeps the longer existing cooldown when a shorter one is recorded for the same key", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const longer = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 600 }),
      "user-1",
    );
    const result = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 60 }),
      "user-1",
    );

    expect(result).toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    expect(result.expiresAt).toEqual(new Date("2026-06-02T12:10:00Z"));
    await expect(store.getActive("garmin", "user-1")).resolves.toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    vi.useRealTimers();
  });

  it("extends the cooldown when a longer one is recorded after a shorter one", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "garmin", retryAfterSeconds: 60 }), "user-1");
    const longer = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(longer.expiresAt).toEqual(new Date("2026-06-02T12:10:00Z"));
    expect(longer.consecutiveHits).toBe(2);
    await expect(store.getActive("garmin", "user-1")).resolves.toEqual(longer);
    vi.useRealTimers();
  });

  it("keeps the longer Redis cooldown when a shorter one is recorded for the same key", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store } = createMockRedisStore();

    const longer = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 600 }),
      "user-1",
    );
    const result = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 60 }),
      "user-1",
    );

    expect(result).toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    // The second set still writes the longer expiry with a TTL reflecting it.
    expect(setCalls[1]).toEqual({
      key: "provider-rate-limit:garmin:provider",
      value: JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        expiresAt: "2026-06-02T12:10:00.000Z",
        consecutiveHits: 2,
      }),
      mode: "PX",
      millisecondsToExpire: 600_000,
    });
    await expect(store.getActive("garmin", "user-1")).resolves.toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    vi.useRealTimers();
  });

  it("falls back to the sync job user for user-scoped errors without an error user", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: null,
        retryAfterSeconds: 120,
      }),
      "fallback-user",
    );

    expect(cooldown.userId).toBe("fallback-user");
    await expect(store.getActive("fitbit", "fallback-user")).resolves.toEqual(cooldown);
    vi.useRealTimers();
  });

  it("ignores expired cooldown state", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "withings", retryAfterSeconds: 60 }), "user-1");
    vi.setSystemTime(new Date("2026-06-02T12:01:01Z"));

    await expect(store.getActive("withings", "user-1")).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("returns null when no cooldown state exists", async () => {
    const store = new InMemoryProviderRateLimitCooldownStore();

    await expect(store.getActive("garmin", "user-1")).resolves.toBeNull();
  });

  it("records provider cooldown state in Redis with serialized expiry", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store } = createMockRedisStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "garmin", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(setCalls).toEqual([
      {
        key: "provider-rate-limit:garmin:provider",
        value: JSON.stringify({
          providerId: "garmin",
          scope: "provider",
          userId: null,
          expiresAt: "2026-06-02T12:10:00.000Z",
          consecutiveHits: 1,
        }),
        mode: "PX",
        millisecondsToExpire: 600_000,
      },
    ]);
    await expect(store.getActive("garmin", "user-1")).resolves.toEqual(cooldown);
    vi.useRealTimers();
  });

  it("records user cooldown state in Redis with user-specific key", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store } = createMockRedisStore();

    const cooldown = await store.record(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: "user-1",
        retryAfterSeconds: 120,
      }),
      "fallback-user",
    );

    expect(setCalls[0]).toEqual({
      key: "provider-rate-limit:fitbit:user:user-1",
      value: JSON.stringify({
        providerId: "fitbit",
        scope: "user",
        userId: "user-1",
        expiresAt: "2026-06-02T12:02:00.000Z",
        consecutiveHits: 1,
      }),
      mode: "PX",
      millisecondsToExpire: 120_000,
    });
    await expect(store.getActive("fitbit", "user-1")).resolves.toEqual(cooldown);
    vi.useRealTimers();
  });

  it("ignores malformed Redis cooldown state", async () => {
    const { values, store } = createMockRedisStore();

    for (const raw of [
      "null",
      "42",
      JSON.stringify({ scope: "provider", userId: null, expiresAt: "2026-06-02T12:00:00.000Z" }),
      JSON.stringify({
        providerId: "garmin",
        scope: "unknown",
        userId: null,
        expiresAt: "2026-06-02T12:00:00.000Z",
      }),
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: 1,
        expiresAt: "2026-06-02T12:00:00.000Z",
      }),
      JSON.stringify({ providerId: "garmin", scope: "provider", userId: null, expiresAt: 1 }),
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        expiresAt: "not-a-date",
      }),
    ]) {
      values.set("provider-rate-limit:garmin:provider", raw);
      await expect(store.getActive("garmin", "user-1")).resolves.toBeNull();
    }
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

  it("builds BullMQ-safe delayed retry job IDs", () => {
    const cooldown = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };

    const jobId = providerRateLimitCooldownJobId(cooldown, "user-1");

    expect(jobId).toBe("provider-rate-limit-garmin-provider-user-1-1780402200000");
  });
});
