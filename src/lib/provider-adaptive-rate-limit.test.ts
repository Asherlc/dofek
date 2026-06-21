import { ADAPTIVE_RATE_WINDOW_MS } from "@dofek/provider-http/adaptive-rate-limit";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryAdaptiveRateLimitStore,
  providerAdaptiveRateLimitStore,
  RedisAdaptiveRateLimitStore,
} from "./provider-adaptive-rate-limit.ts";

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

function createMockRedisAdaptiveStore() {
  const values = new Map<string, string>();
  const setCalls: Array<{
    key: string;
    value: string;
    mode: "PX";
    millisecondsToExpire: number;
  }> = [];
  const getRedisClient: ConstructorParameters<typeof RedisAdaptiveRateLimitStore>[0] = async () => ({
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
    store: new RedisAdaptiveRateLimitStore(getRedisClient),
  };
}

describe("InMemoryAdaptiveRateLimitStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("tracks rolling request counts and learns cooldown from rate limits", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();

    await store.awaitAdmission("whoop", "provider", null);
    await store.awaitAdmission("whoop", "provider", null);

    await store.recordRateLimit(rateLimitError({ providerId: "whoop", retryAfterSeconds: 300 }));

    expect(await store.getLearnedCooldownSeconds("whoop")).toBe(300);
  });

  it("records user-scoped rate limits separately from provider scope", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();

    await store.recordRateLimit(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: "user-1",
        retryAfterSeconds: 90,
      }),
    );

    expect(await store.getLearnedCooldownSeconds("fitbit")).toBeNull();
    await store.awaitAdmission("fitbit", "user", "user-1");
    await store.recordRateLimit(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: "user-1",
        retryAfterSeconds: 120,
      }),
    );
    await store.awaitAdmission("fitbit", "provider", null);
  });

  it("applies Strava quota headers on successful responses", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    await store.recordSuccess("strava", "provider", null, headers);
    await store.awaitAdmission("strava", "provider", null);
  });

  it("ignores response headers for non-Strava providers", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    await store.recordSuccess("garmin", "provider", null, headers);
    await store.awaitAdmission("garmin", "provider", null);
  });

  it("records success without response headers", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();
    await store.recordSuccess("whoop", "provider", null);
    await store.awaitAdmission("whoop", "provider", null);
  });
});

describe("RedisAdaptiveRateLimitStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists state in Redis with the adaptive key prefix", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await store.awaitAdmission("garmin", "provider", null);

    expect(setCalls.length).toBeGreaterThan(0);
    expect(setCalls[0]?.key).toBe("provider-adaptive-rate:garmin:provider");
    expect(setCalls[0]?.mode).toBe("PX");
    expect(setCalls[0]?.millisecondsToExpire).toBe(ADAPTIVE_RATE_WINDOW_MS * 4);
    expect(setCalls[0]?.value).toContain('"providerId":"garmin"');
  });

  it("uses user-scoped keys when scope is user", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await store.awaitAdmission("whoop", "user", "user-42");

    expect(setCalls[0]?.key).toBe("provider-adaptive-rate:whoop:user:user-42");
  });

  it("loads persisted state on subsequent calls", async () => {
    const { store, values } = createMockRedisAdaptiveStore();

    await store.recordRateLimit(rateLimitError({ providerId: "whoop", retryAfterSeconds: 180 }));
    expect(await store.getLearnedCooldownSeconds("whoop")).toBe(180);

    const redisStore = new RedisAdaptiveRateLimitStore(async () => ({
      set: async (key, value, mode, ms) => {
        values.set(key, value);
        return "OK";
      },
      get: async (key) => values.get(key) ?? null,
    }));
    expect(await redisStore.getLearnedCooldownSeconds("whoop")).toBe(180);
  });

  it("creates fresh state when Redis payload is missing required fields", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:garmin:provider",
      JSON.stringify({ providerId: "garmin", scope: "invalid" }),
    );

    await store.awaitAdmission("garmin", "provider", null);
    expect(values.get("provider-adaptive-rate:garmin:provider")).toContain('"scope":"provider"');
  });

  it("creates fresh state when Redis payload has invalid numeric fields", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:garmin:provider",
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        windowStartMs: "bad",
        requestCount: 0,
        throttleMs: 1000,
        lastRequestMs: null,
      }),
    );

    await store.awaitAdmission("garmin", "provider", null);
    expect(values.get("provider-adaptive-rate:garmin:provider")).toContain('"windowStartMs":');
  });

  it("records Strava quota from Redis-backed success responses", async () => {
    const { store } = createMockRedisAdaptiveStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "99,900",
    });

    await store.recordSuccess("strava", "provider", null, headers);
    await store.awaitAdmission("strava", "provider", null);
  });

  it("records user-scoped rate limits through Redis", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await store.recordRateLimit(
      rateLimitError({
        providerId: "fitbit",
        scope: "user",
        userId: "user-9",
        retryAfterSeconds: 45,
      }),
    );

    expect(setCalls.some((call) => call.key === "provider-adaptive-rate:fitbit:user:user-9")).toBe(
      true,
    );
  });

  it("round-trips optional Strava quota fields through Redis", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:strava:provider",
      JSON.stringify({
        providerId: "strava",
        scope: "provider",
        userId: null,
        windowStartMs: 1_000,
        requestCount: 2,
        throttleMs: 10_000,
        lastRequestMs: 900,
        inferredBudget: 35,
        observedCooldownSeconds: 120,
        stravaShortLimit: 100,
        stravaShortUsage: 90,
        stravaDailyLimit: 1000,
        stravaDailyUsage: 400,
      }),
    );

    await store.awaitAdmission("strava", "provider", null);
    const saved = JSON.parse(values.get("provider-adaptive-rate:strava:provider") ?? "{}");
    expect(saved.stravaShortUsage).toBe(90);
    expect(saved.inferredBudget).toBe(35);
  });

  it("rejects persisted state with invalid userId", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:whoop:user:user-1",
      JSON.stringify({
        providerId: "whoop",
        scope: "user",
        userId: 42,
        windowStartMs: 1_000,
        requestCount: 0,
        throttleMs: 1_000,
        lastRequestMs: null,
      }),
    );

    await store.awaitAdmission("whoop", "user", "user-1");
    expect(values.get("provider-adaptive-rate:whoop:user:user-1")).toContain('"userId":"user-1"');
  });

  it("rejects persisted state with invalid lastRequestMs", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:garmin:provider",
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        windowStartMs: 1_000,
        requestCount: 0,
        throttleMs: 1_000,
        lastRequestMs: "now",
      }),
    );

    await store.awaitAdmission("garmin", "provider", null);
    const saved = JSON.parse(values.get("provider-adaptive-rate:garmin:provider") ?? "{}");
    expect(saved.lastRequestMs).not.toBe("now");
    expect(typeof saved.lastRequestMs).toBe("number");
  });

  it("rejects persisted state with non-finite optional numeric fields", async () => {
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:garmin:provider",
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        windowStartMs: 1_000,
        requestCount: 0,
        throttleMs: 1_000,
        lastRequestMs: null,
        inferredBudget: "lots",
        observedCooldownSeconds: "slow",
        stravaShortLimit: "x",
        stravaShortUsage: "y",
        stravaDailyLimit: "z",
        stravaDailyUsage: "w",
      }),
    );

    await store.awaitAdmission("garmin", "provider", null);
    const saved = JSON.parse(values.get("provider-adaptive-rate:garmin:provider") ?? "{}");
    expect(saved.inferredBudget).toBeNull();
    expect(saved.observedCooldownSeconds).toBeNull();
  });
});

describe("providerAdaptiveRateLimitStore", () => {
  it("uses the in-memory store under vitest", () => {
    expect(providerAdaptiveRateLimitStore).toBeInstanceOf(InMemoryAdaptiveRateLimitStore);
  });
});
