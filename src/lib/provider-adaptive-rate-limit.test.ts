import * as adaptiveRateLimit from "@dofek/provider-http/adaptive-rate-limit";
import {
  ADAPTIVE_RATE_WINDOW_MS,
  createInitialAdaptiveState,
} from "@dofek/provider-http/adaptive-rate-limit";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markSyncStepAdmissionClaimed,
  runWithSyncStepAdmission,
} from "./sync-step-admission-context.ts";

const sharedRedisMocks = vi.hoisted(() => ({
  set: vi.fn().mockResolvedValue("OK"),
  get: vi.fn().mockResolvedValue(null),
  sharedRedisConnection: vi.fn().mockImplementation(() => ({
    get client() {
      return Promise.resolve({
        set: (...args: unknown[]) => sharedRedisMocks.set(...args),
        get: (...args: unknown[]) => sharedRedisMocks.get(...args),
      });
    },
  })),
}));

vi.mock("../jobs/queues.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../jobs/queues.ts")>();
  return {
    ...original,
    getRedisConnection: vi.fn().mockReturnValue({}),
    getSharedRedisConnection: sharedRedisMocks.sharedRedisConnection,
  };
});

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

function createMockRedisAdaptiveStore(options?: { atomic?: boolean; execFailCount?: number }) {
  const values = new Map<string, string>();
  const setCalls: Array<{
    key: string;
    value: string;
    mode: "PX";
    millisecondsToExpire: number;
  }> = [];
  const watchCalls: string[] = [];
  let execAttempts = 0;

  const client = {
    set: async (key: string, value: string, mode: "PX", millisecondsToExpire: number) => {
      setCalls.push({ key, value, mode, millisecondsToExpire });
      values.set(key, value);
      return "OK";
    },
    get: async (key: string) => values.get(key) ?? null,
    ...(options?.atomic
      ? {
          watch: async (key: string) => {
            watchCalls.push(key);
            return "OK";
          },
          unwatch: async () => "OK",
          multi: () => {
            let pending:
              | {
                  key: string;
                  value: string;
                  mode: "PX";
                  millisecondsToExpire: number;
                }
              | undefined;
            const chain = {
              set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => {
                pending = { key, value, mode, millisecondsToExpire };
                return chain;
              },
              exec: async () => {
                execAttempts++;
                if (options.execFailCount && execAttempts <= options.execFailCount) {
                  return null;
                }
                if (pending) {
                  setCalls.push(pending);
                  values.set(pending.key, pending.value);
                }
                return ["OK"];
              },
            };
            return chain;
          },
        }
      : {}),
  };

  const getRedisClient: ConstructorParameters<typeof RedisAdaptiveRateLimitStore>[0] = async () =>
    client;

  return {
    values,
    setCalls,
    watchCalls,
    get execAttempts() {
      return execAttempts;
    },
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

  it("tracks in-memory admission delays outside vitest", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = new InMemoryAdaptiveRateLimitStore();

    const firstAdmission = store.awaitAdmission("whoop", "provider", null);
    await vi.advanceTimersByTimeAsync(10_000);
    await firstAdmission;
    vi.setSystemTime(500);
    const secondAdmission = store.awaitAdmission("whoop", "provider", null);
    await vi.advanceTimersByTimeAsync(10_000);
    await secondAdmission;

    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 0),
    ).toBe(true);
  });

  it("stores Strava quota fields in the in-memory store", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = new InMemoryAdaptiveRateLimitStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "99,900",
    });

    await store.recordSuccess("strava", "provider", null, headers);
    const admission = store.awaitAdmission("strava", "provider", null);
    await vi.advanceTimersByTimeAsync(120_000);
    await admission;

    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => typeof delay === "number" && delay >= 40_000),
    ).toBe(true);
  });

  it("records success without response headers", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();
    await store.recordSuccess("whoop", "provider", null);
    await store.awaitAdmission("whoop", "provider", null);
  });

  it("records only one budget admission per garmin sync step in memory", async () => {
    const requestSpy = vi.spyOn(adaptiveRateLimit, "recordAdaptiveRequest");
    const touchSpy = vi.spyOn(adaptiveRateLimit, "recordAdaptiveThrottleTouch");
    const store = new InMemoryAdaptiveRateLimitStore();

    await runWithSyncStepAdmission(async () => {
      await store.awaitAdmission("garmin", "provider", null);
      await store.awaitAdmission("garmin", "provider", null);
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).toHaveBeenCalledTimes(1);
    requestSpy.mockRestore();
    touchSpy.mockRestore();
  });

  it("throttles in-memory callers that lose the sync-step budget race", async () => {
    const requestSpy = vi.spyOn(adaptiveRateLimit, "recordAdaptiveRequest");
    const touchSpy = vi.spyOn(adaptiveRateLimit, "recordAdaptiveThrottleTouch");
    const store = new InMemoryAdaptiveRateLimitStore();

    await runWithSyncStepAdmission(async () => {
      markSyncStepAdmissionClaimed();
      await store.awaitAdmission("garmin", "provider", null);
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(touchSpy).toHaveBeenCalledTimes(1);
    requestSpy.mockRestore();
    touchSpy.mockRestore();
  });

  it("counts concurrent in-memory sync-step admissions once", async () => {
    const requestSpy = vi.spyOn(adaptiveRateLimit, "recordAdaptiveRequest");
    const store = new InMemoryAdaptiveRateLimitStore();

    await runWithSyncStepAdmission(async () => {
      await Promise.all([
        store.awaitAdmission("garmin", "provider", null),
        store.awaitAdmission("garmin", "provider", null),
        store.awaitAdmission("garmin", "provider", null),
      ]);
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    requestSpy.mockRestore();
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
    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.requestCount).toBe(1);
  });

  it("increments request count after admission", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await store.awaitAdmission("whoop", "provider", null);
    await store.awaitAdmission("whoop", "provider", null);

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.requestCount).toBe(2);
  });

  it("counts only the first HTTP admission in a sync step for step-chain providers", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await runWithSyncStepAdmission(async () => {
      await store.awaitAdmission("garmin", "provider", null);
      await store.awaitAdmission("garmin", "provider", null);
      await store.awaitAdmission("garmin", "provider", null);
    });

    let saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.requestCount).toBe(1);

    await runWithSyncStepAdmission(async () => {
      await store.awaitAdmission("garmin", "provider", null);
    });

    saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.requestCount).toBe(2);
  });

  it("counts only one HTTP admission when concurrent requests race in a sync step", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await runWithSyncStepAdmission(async () => {
      await Promise.all([
        store.awaitAdmission("garmin", "provider", null),
        store.awaitAdmission("garmin", "provider", null),
        store.awaitAdmission("garmin", "provider", null),
      ]);
    });

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.requestCount).toBe(1);
  });

  it("persists throttle touches for additional sync-step HTTP calls", async () => {
    const mock = createMockRedisAdaptiveStore({ atomic: true });

    await runWithSyncStepAdmission(async () => {
      await mock.store.awaitAdmission("garmin", "provider", null);
      const savesAfterFirst = mock.setCalls.length;
      await mock.store.awaitAdmission("garmin", "provider", null);
      expect(mock.setCalls.length).toBeGreaterThan(savesAfterFirst);
    });
  });

  it("routes claimed sync-step admissions through the throttle-only Redis path", async () => {
    const mock = createMockRedisAdaptiveStore();

    await runWithSyncStepAdmission(async () => {
      await mock.store.awaitAdmission("garmin", "provider", null);
      const savesAfterFirst = mock.setCalls.length;
      await mock.store.awaitAdmission("garmin", "provider", null);
      expect(mock.setCalls.length).toBeGreaterThan(savesAfterFirst);
    });
  });

  it("stores Strava quota fields after recordSuccess", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    const beforeSuccessMs = Date.now();
    await store.recordSuccess("strava", "provider", null, headers);
    const afterSuccessMs = Date.now();

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.stravaShortLimit).toBe(100);
    expect(saved.stravaShortUsage).toBe(95);
    expect(saved.stravaDailyLimit).toBe(1000);
    expect(saved.stravaDailyUsage).toBe(400);
    expect(saved.lastRequestMs).toBeGreaterThanOrEqual(beforeSuccessMs);
    expect(saved.lastRequestMs).toBeLessThanOrEqual(afterSuccessMs);
  });

  it("preserves the admitted request timestamp when recording Strava quota", async () => {
    const { store, setCalls, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:strava:provider",
      JSON.stringify({
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 1_234,
      }),
    );
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    await store.recordSuccess("strava", "provider", null, headers);

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.lastRequestMs).toBe(1_234);
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
      set: async (key, value, _mode, _millisecondsToExpire) => {
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
    const { store, setCalls } = createMockRedisAdaptiveStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "99,900",
    });

    await store.recordSuccess("strava", "provider", null, headers);

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.stravaShortUsage).toBe(99);
    expect(saved.stravaDailyUsage).toBe(900);
  });

  it("records provider-scoped rate limits under the provider key", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();

    await store.recordRateLimit(
      rateLimitError({
        providerId: "whoop",
        scope: "provider",
        userId: "user-1",
        retryAfterSeconds: 90,
      }),
    );

    expect(setCalls.some((call) => call.key === "provider-adaptive-rate:whoop:provider")).toBe(
      true,
    );
    expect(setCalls.some((call) => call.key === "provider-adaptive-rate:whoop:user:user-1")).toBe(
      false,
    );
  });

  it("does not apply Strava quota headers to other providers", async () => {
    const { store, setCalls } = createMockRedisAdaptiveStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    await store.recordSuccess("garmin", "provider", null, headers);

    const saved = JSON.parse(setCalls.at(-1)?.value ?? "{}");
    expect(saved.stravaShortUsage).toBeNull();
    expect(saved.stravaDailyUsage).toBeNull();
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
    expect(setCalls.some((call) => call.key === "provider-adaptive-rate:fitbit:provider")).toBe(
      false,
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

  it("uses atomic Redis WATCH/MULTI admission when available", async () => {
    const mock = createMockRedisAdaptiveStore({ atomic: true });

    await mock.store.awaitAdmission("garmin", "provider", null);

    expect(mock.watchCalls).toEqual(["provider-adaptive-rate:garmin:provider"]);
    const saved = JSON.parse(mock.values.get("provider-adaptive-rate:garmin:provider") ?? "{}");
    expect(saved.requestCount).toBe(1);
  });

  it("retries atomic Redis admission when exec reports a conflict", async () => {
    const mock = createMockRedisAdaptiveStore({ atomic: true, execFailCount: 1 });

    await mock.store.awaitAdmission("garmin", "provider", null);

    expect(mock.watchCalls).toEqual([
      "provider-adaptive-rate:garmin:provider",
      "provider-adaptive-rate:garmin:provider",
    ]);
    expect(mock.execAttempts).toBe(2);
  });

  it("completes atomic Strava admission after the quota pacing interval elapses", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const mock = createMockRedisAdaptiveStore({ atomic: true });
    mock.values.set(
      "provider-adaptive-rate:strava:provider",
      JSON.stringify({
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 20_000,
        stravaShortLimit: 200,
        stravaShortUsage: 1,
        stravaDailyLimit: 2_000,
        stravaDailyUsage: 38,
      }),
    );

    const admission = mock.store.awaitAdmission("strava", "provider", null);
    await vi.advanceTimersByTimeAsync(20_000);
    await admission;

    expect(mock.execAttempts).toBe(1);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("completes atomic Strava admission with quota state but no prior request timestamp", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const mock = createMockRedisAdaptiveStore({ atomic: true });
    mock.values.set(
      "provider-adaptive-rate:strava:provider",
      JSON.stringify({
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: null,
        stravaShortLimit: 200,
        stravaShortUsage: 1,
        stravaDailyLimit: 2_000,
        stravaDailyUsage: 38,
      }),
    );

    await mock.store.awaitAdmission("strava", "provider", null);

    expect(mock.execAttempts).toBe(1);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("creates fresh adaptive state when Redis returns null during atomic admission", async () => {
    const mock = createMockRedisAdaptiveStore({ atomic: true });

    await mock.store.awaitAdmission("whoop", "provider", null);

    const saved = JSON.parse(mock.values.get("provider-adaptive-rate:whoop:provider") ?? "{}");
    expect(saved.providerId).toBe("whoop");
    expect(saved.requestCount).toBe(1);
  });

  it("creates fresh adaptive state when Redis payload is invalid during atomic admission", async () => {
    const mock = createMockRedisAdaptiveStore({ atomic: true });
    mock.values.set("provider-adaptive-rate:garmin:provider", "not-json");

    await mock.store.awaitAdmission("garmin", "provider", null);

    const saved = JSON.parse(mock.values.get("provider-adaptive-rate:garmin:provider") ?? "{}");
    expect(saved.scope).toBe("provider");
    expect(saved.requestCount).toBe(1);
  });
});

describe("providerAdaptiveRateLimitStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the in-memory store under vitest", () => {
    expect(providerAdaptiveRateLimitStore.constructor.name).toBe("InMemoryAdaptiveRateLimitStore");
  });

  it("initializes the exported store from the active test environment", async () => {
    vi.resetModules();
    const mod = await import("./provider-adaptive-rate-limit.ts");
    expect(mod.providerAdaptiveRateLimitStore.constructor.name).toBe(
      "InMemoryAdaptiveRateLimitStore",
    );
  });

  it("uses the Redis store outside test environments and exercises getSharedRedisClient", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    const transaction = {
      set: vi.fn(),
      exec: vi.fn().mockResolvedValue([["OK"]]),
    };
    transaction.set.mockReturnValue(transaction);
    const mockClient = {
      set: vi.fn().mockResolvedValue("OK"),
      get: vi.fn().mockResolvedValue(null),
      watch: vi.fn().mockResolvedValue("OK"),
      unwatch: vi.fn().mockResolvedValue("OK"),
      multi: vi.fn().mockReturnValue(transaction),
    };
    vi.doMock("../jobs/queues.ts", () => ({
      getRedisConnection: vi.fn().mockReturnValue({}),
      getSharedRedisConnection: vi.fn().mockImplementation(() => ({
        get client() {
          return Promise.resolve(mockClient);
        },
      })),
    }));
    vi.resetModules();

    const mod = await import("./provider-adaptive-rate-limit.ts");
    expect(mod.providerAdaptiveRateLimitStore.constructor.name).toBe("RedisAdaptiveRateLimitStore");
    await expect(
      mod.providerAdaptiveRateLimitStore.getLearnedCooldownSeconds("garmin"),
    ).resolves.toBeNull();
    expect(mockClient.get).toHaveBeenCalled();
    await mod.providerAdaptiveRateLimitStore.recordSuccess("garmin", "provider", null);
    expect(mockClient.set).toHaveBeenCalledWith(
      "provider-adaptive-rate:garmin:provider",
      expect.any(String),
      "PX",
      ADAPTIVE_RATE_WINDOW_MS * 4,
    );

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mockClient.get
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          ...createInitialAdaptiveState("garmin", "provider", null, 1_000),
          lastRequestMs: 1_000,
          throttleMs: 100,
        }),
      )
      .mockResolvedValue(null);
    const admission = mod.providerAdaptiveRateLimitStore.awaitAdmission("garmin", "provider", null);
    await vi.advanceTimersByTimeAsync(100);
    await admission;
    expect(mockClient.watch).toHaveBeenCalledWith("provider-adaptive-rate:garmin:provider");
    expect(mockClient.unwatch).toHaveBeenCalledOnce();
    expect(mockClient.multi).toHaveBeenCalledOnce();
    expect(transaction.set).toHaveBeenCalledWith(
      "provider-adaptive-rate:garmin:provider",
      expect.any(String),
      "PX",
      ADAPTIVE_RATE_WINDOW_MS * 4,
    );
    expect(transaction.exec).toHaveBeenCalledOnce();
    vi.useRealTimers();

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("waits for admission delay outside test environments", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { store, values } = createMockRedisAdaptiveStore();
    values.set(
      "provider-adaptive-rate:garmin:provider",
      JSON.stringify({
        ...createInitialAdaptiveState("garmin", "provider", null, 1_000),
        throttleMs: 5_000,
        lastRequestMs: 1_000,
      }),
    );

    const admission = store.awaitAdmission("garmin", "provider", null);
    await vi.advanceTimersByTimeAsync(5_000);
    await admission;

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(
      setTimeoutSpy.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 0),
    ).toBe(true);
    expect(
      JSON.parse(values.get("provider-adaptive-rate:garmin:provider") ?? "{}").requestCount,
    ).toBe(1);
  });

  it("still skips admission delay when NODE_ENV is test but VITEST is unset", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = new InMemoryAdaptiveRateLimitStore();

    await store.awaitAdmission("whoop", "provider", null);
    vi.setSystemTime(100);
    const secondAdmission = store.awaitAdmission("whoop", "provider", null);
    await vi.advanceTimersByTimeAsync(5_000);
    await secondAdmission;

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
