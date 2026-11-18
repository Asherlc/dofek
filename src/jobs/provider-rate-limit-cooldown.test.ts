import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerAdaptiveRateLimitStore } from "../lib/provider-adaptive-rate-limit.ts";
import {
  InMemoryProviderRateLimitCooldownStore,
  parseProviderRateLimitCooldown,
  providerRateLimitCooldownJobId,
  providerRateLimitCooldownStore,
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

function createMockRedisStore(conflictCount = 0) {
  const values = new Map<string, string>();
  const setCalls: Array<{
    key: string;
    value: string;
    mode: "PX";
    millisecondsToExpire: number;
  }> = [];
  const compareCalls: string[] = [];
  const client = {
    get: async (key: string) => values.get(key) ?? null,
    eval: async (
      _script: string,
      _keys: number,
      key: string,
      hasPrevious: string,
      previous: string,
      next: string,
      ttlMs: number,
    ) => {
      compareCalls.push(key);
      const expected = hasPrevious === "1" ? previous : null;
      if (compareCalls.length <= conflictCount || (values.get(key) ?? null) !== expected) return 0;
      values.set(key, next);
      setCalls.push({ key, value: next, mode: "PX", millisecondsToExpire: ttlMs });
      return 1;
    },
  };

  return {
    values,
    setCalls,
    compareCalls,
    store: new RedisProviderRateLimitCooldownStore(async () => client),
  };
}

describe("ProviderRateLimitCooldownStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists an explicit service outage delay with a distinct reason", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { store } = createMockRedisStore();
    await store.record(
      new ProviderServiceUnavailableError({
        message: "Provider unavailable",
        providerId: "example",
        statusCode: 503,
        responseBody: "",
        retryAfterSeconds: 300,
      }),
      "user-1",
    );

    expect(await store.getActive("example", "user-2")).toMatchObject({
      reason: "service_unavailable",
      scope: "provider",
      expiresAt: new Date("2026-06-02T12:05:00Z"),
    });
  });

  it.each([null, 0, -1])(
    "rejects a service outage delay of %j before writing a cooldown",
    async (retryAfterSeconds) => {
      const { store, setCalls } = createMockRedisStore();
      const outage = new ProviderServiceUnavailableError({
        message: "Provider unavailable",
        providerId: "example",
        statusCode: 503,
        responseBody: "",
        retryAfterSeconds,
      });

      await expect(store.record(outage, "user-1")).rejects.toThrow(
        "A service outage cooldown requires a positive Retry-After delay",
      );
      expect(setCalls).toHaveLength(0);
    },
  );

  it("starts rate-limit escalation at the first hit after an outage", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();
    await store.record(
      new ProviderServiceUnavailableError({
        message: "Provider unavailable",
        providerId: "example",
        statusCode: 503,
        responseBody: "",
        retryAfterSeconds: 60,
      }),
      "user-1",
    );

    await expect(
      store.record(rateLimitError({ providerId: "example" }), "user-1"),
    ).resolves.toMatchObject({
      consecutiveHits: 1,
      expiresAt: new Date("2026-06-02T12:30:00Z"),
    });
    vi.useRealTimers();
  });

  it("records provider-wide cooldown state using Retry-After when present", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(cooldown).toEqual({
      providerId: "example",
      scope: "provider",
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
      consecutiveHits: 1,
    });
    await expect(store.getActive("example", "user-2")).resolves.toEqual(cooldown);
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

  it("uses the Withings-specific fallback cooldown when Retry-After is absent", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(rateLimitError({ providerId: "withings" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:01:00Z"));
    vi.useRealTimers();
  });

  it("uses the Whoop-specific fallback cooldown when Retry-After is absent", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(rateLimitError({ providerId: "whoop" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T13:00:00Z"));
    vi.useRealTimers();
  });

  it("uses the default fallback cooldown for providers without a custom value", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(rateLimitError({ providerId: "polar" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:30:00Z"));
    vi.useRealTimers();
  });

  it("caps Whoop escalation at the provider-specific four-hour maximum", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    let cooldown = await store.record(rateLimitError({ providerId: "whoop" }), "user-1");
    for (let hit = 1; hit < 3; hit++) {
      vi.setSystemTime(cooldown.expiresAt);
      cooldown = await store.record(rateLimitError({ providerId: "whoop" }), "user-1");
    }

    expect(cooldown.consecutiveHits).toBe(3);
    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T19:00:00Z"));
    vi.useRealTimers();
  });

  it("uses provider fallback cooldown state when Retry-After is zero", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 0 }),
      "user-1",
    );

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:30:00Z"));
    vi.useRealTimers();
  });

  it("escalates fallback cooldown duration on consecutive rate-limit hits", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const first = await store.record(rateLimitError({ providerId: "example" }), "user-1");
    expect(first.consecutiveHits).toBe(1);
    expect(first.expiresAt).toEqual(new Date("2026-06-02T12:30:00Z"));

    vi.setSystemTime(new Date("2026-06-02T12:30:00Z"));
    const second = await store.record(rateLimitError({ providerId: "example" }), "user-1");
    expect(second.consecutiveHits).toBe(2);
    expect(second.expiresAt).toEqual(new Date("2026-06-02T13:30:00Z"));
    vi.useRealTimers();
  });

  it("resets consecutive hits after the strike reset window elapses", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "example" }), "user-1");
    vi.setSystemTime(new Date("2026-06-02T14:30:01Z"));

    const second = await store.record(rateLimitError({ providerId: "example" }), "user-1");
    expect(second.consecutiveHits).toBe(1);
    vi.useRealTimers();
  });

  it("keeps escalating strikes within the strike reset window", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "example" }), "user-1");
    vi.setSystemTime(new Date("2026-06-02T14:30:00Z"));

    const second = await store.record(rateLimitError({ providerId: "example" }), "user-1");
    expect(second.consecutiveHits).toBe(2);
    vi.useRealTimers();
  });

  it("caps escalation at the default max cooldown for providers without a custom max", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    let cooldown = await store.record(rateLimitError({ providerId: "strava" }), "user-1");
    for (let hit = 1; hit < 4; hit++) {
      vi.setSystemTime(cooldown.expiresAt);
      cooldown = await store.record(rateLimitError({ providerId: "strava" }), "user-1");
    }

    expect(cooldown.consecutiveHits).toBe(4);
    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T15:45:00Z"));
    vi.useRealTimers();
  });

  it("uses learned cooldown seconds from the adaptive store when Retry-After is absent", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    vi.spyOn(providerAdaptiveRateLimitStore, "getLearnedCooldownSeconds").mockResolvedValue(300);
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(rateLimitError({ providerId: "example" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:05:00Z"));
    vi.useRealTimers();
  });

  it("ignores negative Retry-After values and uses escalated fallback cooldown", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: -10 }),
      "user-1",
    );

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:30:00Z"));
    vi.useRealTimers();
  });

  it("updates consecutive hits when a new cooldown matches the active expiry", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "example", retryAfterSeconds: 600 }), "user-1");
    const second = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(second.consecutiveHits).toBe(2);
    expect(second.expiresAt).toEqual(new Date("2026-06-02T12:10:00Z"));
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
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );
    const result = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 60 }),
      "user-1",
    );

    expect(result).toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    expect(result.expiresAt).toEqual(new Date("2026-06-02T12:10:00Z"));
    await expect(store.getActive("example", "user-1")).resolves.toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    vi.useRealTimers();
  });

  it("extends the cooldown when a longer one is recorded after a shorter one", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const store = new InMemoryProviderRateLimitCooldownStore();

    await store.record(rateLimitError({ providerId: "example", retryAfterSeconds: 60 }), "user-1");
    const longer = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(longer.expiresAt).toEqual(new Date("2026-06-02T12:10:00Z"));
    expect(longer.consecutiveHits).toBe(2);
    await expect(store.getActive("example", "user-1")).resolves.toEqual(longer);
    vi.useRealTimers();
  });

  it("keeps the longer Redis cooldown when a shorter one is recorded for the same key", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store } = createMockRedisStore();

    const longer = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );
    const result = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 60 }),
      "user-1",
    );

    expect(result).toEqual({
      ...longer,
      consecutiveHits: 2,
    });
    // The second set still writes the longer expiry with a TTL reflecting it.
    expect(setCalls[1]).toEqual({
      key: "provider-rate-limit:example:provider",
      value: JSON.stringify({
        providerId: "example",
        scope: "provider",
        userId: null,
        expiresAt: "2026-06-02T12:10:00.000Z",
        consecutiveHits: 2,
      }),
      mode: "PX",
      millisecondsToExpire: 600_000,
    });
    await expect(store.getActive("example", "user-1")).resolves.toEqual({
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

    await expect(store.getActive("example", "user-1")).resolves.toBeNull();
  });

  it("records provider cooldown state in Redis with serialized expiry", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store } = createMockRedisStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(setCalls).toEqual([
      {
        key: "provider-rate-limit:example:provider",
        value: JSON.stringify({
          providerId: "example",
          scope: "provider",
          userId: null,
          expiresAt: "2026-06-02T12:10:00.000Z",
          consecutiveHits: 1,
        }),
        mode: "PX",
        millisecondsToExpire: 600_000,
      },
    ]);
    await expect(store.getActive("example", "user-1")).resolves.toEqual(cooldown);
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

  it("uses learned cooldown seconds in Redis when Retry-After is absent", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    vi.spyOn(providerAdaptiveRateLimitStore, "getLearnedCooldownSeconds").mockResolvedValue(300);
    const { setCalls, store } = createMockRedisStore();

    const cooldown = await store.record(rateLimitError({ providerId: "example" }), "user-1");

    expect(cooldown.expiresAt).toEqual(new Date("2026-06-02T12:05:00Z"));
    expect(setCalls[0]?.millisecondsToExpire).toBe(300_000);
    vi.useRealTimers();
  });

  it("ignores malformed Redis cooldown state", async () => {
    const { values, store } = createMockRedisStore();

    for (const raw of [
      "null",
      "42",
      JSON.stringify({ scope: "provider", userId: null, expiresAt: "2026-06-02T12:00:00.000Z" }),
      JSON.stringify({
        providerId: "example",
        scope: "unknown",
        userId: null,
        expiresAt: "2026-06-02T12:00:00.000Z",
      }),
      JSON.stringify({
        providerId: "example",
        scope: "provider",
        userId: 1,
        expiresAt: "2026-06-02T12:00:00.000Z",
      }),
      JSON.stringify({ providerId: "example", scope: "provider", userId: null, expiresAt: 1 }),
      JSON.stringify({
        providerId: "example",
        scope: "provider",
        userId: null,
        expiresAt: "not-a-date",
      }),
      JSON.stringify({
        providerId: "example",
        scope: "provider",
        userId: null,
        expiresAt: "2026-06-02T12:00:00.000Z",
        consecutiveHits: "not-a-number",
      }),
      JSON.stringify({
        providerId: "example",
        scope: "provider",
        userId: null,
        expiresAt: "2026-06-02T12:00:00.000Z",
        consecutiveHits: null,
      }),
    ]) {
      values.set("provider-rate-limit:example:provider", raw);
      await expect(store.getActive("example", "user-1")).resolves.toBeNull();
    }
  });

  it("records cooldown state through the Redis compare-and-set path when available", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const { setCalls, store, compareCalls } = createMockRedisStore();

    const cooldown = await store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(compareCalls).toEqual(["provider-rate-limit:example:provider"]);
    expect(setCalls).toEqual([
      {
        key: "provider-rate-limit:example:provider",
        value: JSON.stringify({
          providerId: "example",
          scope: "provider",
          userId: null,
          expiresAt: "2026-06-02T12:10:00.000Z",
          consecutiveHits: 1,
        }),
        mode: "PX",
        millisecondsToExpire: 600_000,
      },
    ]);
    await expect(store.getActive("example", "user-1")).resolves.toEqual(cooldown);
    vi.useRealTimers();
  });

  it("throws when Redis compare-and-set writes exceed the retry limit", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const mock = createMockRedisStore(Number.POSITIVE_INFINITY);

    await expect(
      mock.store.record(
        rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
        "user-1",
      ),
    ).rejects.toThrow(
      "Failed to persist rate-limit cooldown for provider-rate-limit:example:provider after 10 Redis transaction conflicts",
    );

    expect(mock.compareCalls.length).toBe(10);
    vi.useRealTimers();
  });

  it("retries Redis compare-and-set writes when another write wins", async () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
    const mock = createMockRedisStore(1);

    await mock.store.record(
      rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
      "user-1",
    );

    expect(mock.compareCalls).toEqual([
      "provider-rate-limit:example:provider",
      "provider-rate-limit:example:provider",
    ]);
    expect(mock.compareCalls.length).toBe(2);
    vi.useRealTimers();
  });

  it("uses the in-memory cooldown store under Vitest", () => {
    expect(providerRateLimitCooldownStore).toBeInstanceOf(InMemoryProviderRateLimitCooldownStore);
  });

  it("uses the Redis cooldown store outside test environments", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));

    const mockClient = {
      get: vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue(1),
    };
    vi.doMock("./queues.ts", () => ({
      getRedisConnection: vi.fn().mockReturnValue({}),
      getSharedRedisConnection: vi.fn().mockImplementation(() => ({
        get client() {
          return Promise.resolve(mockClient);
        },
      })),
    }));
    vi.resetModules();

    const module = await import("./provider-rate-limit-cooldown.ts");
    expect(module.providerRateLimitCooldownStore).toBeInstanceOf(
      module.RedisProviderRateLimitCooldownStore,
    );

    await expect(
      module.providerRateLimitCooldownStore.getActive("example", "user-1"),
    ).resolves.toBeNull();
    expect(mockClient.get).toHaveBeenCalledWith("provider-rate-limit:example:provider");
    await expect(
      module.providerRateLimitCooldownStore.record(
        rateLimitError({ providerId: "example", retryAfterSeconds: 600 }),
        "user-1",
      ),
    ).resolves.toMatchObject({
      providerId: "example",
      expiresAt: new Date("2026-06-02T12:10:00.000Z"),
    });
    expect(mockClient.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "provider-rate-limit:example:provider",
      "0",
      "",
      expect.any(String),
      600_000,
    );

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("parseProviderRateLimitCooldown", () => {
  // Active fixtures keep these shape assertions independent of activeOrNull's expiry filtering.
  const activeExpiry = "2099-06-02T12:10:00.000Z";
  const legacyRecord = {
    providerId: "example",
    scope: "provider",
    userId: null,
    expiresAt: activeExpiry,
  };

  it("accepts an active legacy record with no reason or hit count", () => {
    const cooldown = parseProviderRateLimitCooldown(JSON.stringify(legacyRecord));

    expect(cooldown).toEqual({
      ...legacyRecord,
      expiresAt: new Date(activeExpiry),
      reason: undefined,
      consecutiveHits: undefined,
    });
  });

  it("accepts an active supported record with a service-outage reason and hit count", () => {
    const cooldown = parseProviderRateLimitCooldown(
      JSON.stringify({ ...legacyRecord, reason: "service_unavailable", consecutiveHits: 3 }),
    );

    expect(cooldown).toEqual({
      ...legacyRecord,
      expiresAt: new Date(activeExpiry),
      reason: "service_unavailable",
      consecutiveHits: 3,
    });
  });

  it.each(["rate_limited", null, 42])(
    "normalizes an unknown active reason %j away without rejecting the record",
    (reason) => {
      const cooldown = parseProviderRateLimitCooldown(JSON.stringify({ ...legacyRecord, reason }));

      expect(cooldown?.reason).toBeUndefined();
      expect(cooldown?.expiresAt).toEqual(new Date(activeExpiry));
    },
  );

  it.each(["3", null, true, {}])(
    "normalizes malformed active consecutive hits %j without rejecting the record",
    (consecutiveHits) => {
      const cooldown = parseProviderRateLimitCooldown(
        JSON.stringify({ ...legacyRecord, consecutiveHits }),
      );

      expect(cooldown?.consecutiveHits).toBeUndefined();
      expect(cooldown?.expiresAt).toEqual(new Date(activeExpiry));
    },
  );

  it("rejects an invalid expiry while keeping the remaining active fields valid", () => {
    expect(
      parseProviderRateLimitCooldown(JSON.stringify({ ...legacyRecord, expiresAt: "not-a-date" })),
    ).toBeNull();
    expect(
      parseProviderRateLimitCooldown(JSON.stringify({ ...legacyRecord, expiresAt: 1 })),
    ).toBeNull();
  });
});

describe("provider rate-limit scheduling helpers", () => {
  it("computes non-negative delay to a cooldown expiry", () => {
    const cooldown = {
      providerId: "example",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };

    expect(providerRateLimitDelayMs(cooldown, new Date("2026-06-02T12:00:00Z"))).toBe(600_000);
    expect(providerRateLimitDelayMs(cooldown, new Date("2026-06-02T12:11:00Z"))).toBe(0);
  });

  it("builds BullMQ-safe delayed retry job IDs", () => {
    const cooldown = {
      providerId: "example",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };

    const jobId = providerRateLimitCooldownJobId(cooldown, { userId: "user-1" });

    expect(jobId).toMatch(/^provider-rate-limit-example-provider-1780402200000-[a-f0-9]{24}$/);
    expect(providerRateLimitCooldownJobId(cooldown, { userId: "user-2" })).not.toBe(jobId);
  });

  it("keeps distinct delayed requests for the same owner separate", () => {
    const cooldown = {
      providerId: "example",
      scope: "provider" as const,
      userId: null,
      expiresAt: new Date("2026-06-02T12:10:00Z"),
    };
    const first = {
      userId: "owner",
      sinceIso: "2026-06-01T00:00:00Z",
      checkpoint: { page: 1 },
      processingOperationIds: { example: "operation-1" },
    };
    const jobId = providerRateLimitCooldownJobId(cooldown, first);
    expect(providerRateLimitCooldownJobId(cooldown, { ...first })).toBe(jobId);
    expect(
      providerRateLimitCooldownJobId(cooldown, { ...first, sinceIso: "2026-05-01T00:00:00Z" }),
    ).not.toBe(jobId);
    expect(
      providerRateLimitCooldownJobId(cooldown, { ...first, checkpoint: { page: 2 } }),
    ).not.toBe(jobId);
    expect(
      providerRateLimitCooldownJobId(cooldown, {
        ...first,
        processingOperationIds: { example: "operation-2" },
      }),
    ).not.toBe(jobId);
  });
});
