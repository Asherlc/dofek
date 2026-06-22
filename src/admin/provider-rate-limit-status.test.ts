import {
  createInitialAdaptiveState,
  defaultThrottleMs,
  serializeAdaptiveRateState,
} from "@dofek/provider-http/adaptive-rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderRateLimitStatus } from "./provider-rate-limit-status.ts";

interface MockRedisEntry {
  value: string | null;
  expiresAtMs?: number;
}

function matchesRedisScanPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return key === pattern;
}

class MockRedisReader {
  readonly #entries = new Map<string, MockRedisEntry>();

  set(key: string, value: string, expiresAtMs?: number): void {
    this.#entries.set(key, { value, expiresAtMs });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs != null && entry.expiresAtMs <= Date.now()) return null;
    return entry.value;
  }

  async scan(
    cursor: string,
    _matchKeyword: "MATCH",
    pattern: string,
    _countKeyword: "COUNT",
    _count: string,
  ): Promise<[string, string[]]> {
    const keys = [...this.#entries.keys()].filter((key) => matchesRedisScanPattern(key, pattern));
    if (cursor !== "0") return ["0", []];
    return ["0", keys];
  }
}

class PaginatedMockRedisReader extends MockRedisReader {
  readonly #pages: Array<[string, string[]]>;
  #pageIndex = 0;

  constructor(pages: Array<[string, string[]]>) {
    super();
    this.#pages = pages;
  }

  override async scan(
    cursor: string,
    matchKeyword: "MATCH",
    pattern: string,
    countKeyword: "COUNT",
    count: string,
  ): Promise<[string, string[]]> {
    if (cursor === "0") {
      this.#pageIndex = 0;
    }
    const page = this.#pages[this.#pageIndex];
    this.#pageIndex += 1;
    if (page) return page;
    return super.scan(cursor, matchKeyword, pattern, countKeyword, count);
  }
}

const sharedRedisMocks = vi.hoisted(() => ({
  get: vi.fn<(_key: string) => Promise<string | null>>(),
  scan: vi.fn<
    (
      _cursor: string,
      _matchKeyword: "MATCH",
      _pattern: string,
      _countKeyword: "COUNT",
      _count: string,
    ) => Promise<[string, string[]]>
  >(),
  RedisConnection: vi.fn(),
}));

vi.mock("bullmq", () => ({
  RedisConnection: sharedRedisMocks.RedisConnection,
}));

vi.mock("../jobs/queues.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../jobs/queues.ts")>();
  return {
    ...original,
    getRedisConnection: vi.fn().mockReturnValue({}),
  };
});

function providerAdaptiveKey(providerId: string): string {
  return `provider-adaptive-rate:${providerId}:provider`;
}

function userAdaptiveKey(providerId: string, userId: string): string {
  return `provider-adaptive-rate:${providerId}:user:${userId}`;
}

function userCooldownKey(providerId: string, userId: string): string {
  return `provider-rate-limit:${providerId}:user:${userId}`;
}

describe("getProviderRateLimitStatus", () => {
  it("returns configured provider rows with static queue limits", async () => {
    const redis = new MockRedisReader();
    const rows = await getProviderRateLimitStatus(redis);

    const strava = rows.find((row) => row.providerId === "strava" && row.scope === "provider");
    const whoop = rows.find((row) => row.providerId === "whoop" && row.scope === "provider");
    expect(strava).toMatchObject({
      providerId: "strava",
      scope: "provider",
      syncTier: "realtime",
      queueLimiterMax: 90,
      queueLimiterDurationMs: 15 * 60_000,
      defaultThrottleMs: 10_000,
      hasLiveState: false,
    });
    expect(whoop).toMatchObject({
      providerId: "whoop",
      queueLimiterMax: 1,
      queueLimiterDurationMs: 1_000,
      defaultThrottleMs: 1_000,
    });
  });

  it("merges adaptive state and active cooldowns from Redis", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    const adaptiveState = {
      providerId: "garmin",
      scope: "provider" as const,
      userId: null,
      windowStartMs: now.getTime() - 60_000,
      requestCount: 12,
      throttleMs: 4_000,
      lastRequestMs: now.getTime() - 2_000,
      inferredBudget: 18,
      observedCooldownSeconds: 900,
      stravaShortLimit: null,
      stravaShortUsage: null,
      stravaDailyLimit: null,
      stravaDailyUsage: null,
    };
    redis.set(providerAdaptiveKey("garmin"), serializeAdaptiveRateState(adaptiveState));
    redis.set(
      userCooldownKey("garmin", "user-42"),
      JSON.stringify({
        providerId: "garmin",
        scope: "user",
        userId: "user-42",
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        consecutiveHits: 2,
      }),
    );

    const rows = await getProviderRateLimitStatus(redis, now);
    const providerRow = rows.find((row) => row.providerId === "garmin" && row.scope === "provider");
    const userRow = rows.find(
      (row) => row.providerId === "garmin" && row.scope === "user" && row.userId === "user-42",
    );

    expect(providerRow).toMatchObject({
      throttleMs: 4_000,
      inferredBudget: 18,
      requestCount: 12,
      observedCooldownSeconds: 900,
      stravaShortUsage: null,
      hasLiveState: true,
    });
    expect(userRow).toMatchObject({
      cooldownExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      consecutiveHits: 2,
      hasLiveState: true,
    });
  });

  it("sorts provider rows before user rows and by provider id", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    redis.set(
      userCooldownKey("strava", "user-z"),
      JSON.stringify({
        providerId: "strava",
        scope: "user",
        userId: "user-z",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );
    redis.set(
      userCooldownKey("garmin", "user-a"),
      JSON.stringify({
        providerId: "garmin",
        scope: "user",
        userId: "user-a",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );

    const rows = await getProviderRateLimitStatus(redis, now);
    const providerIds = rows.filter((row) => row.scope === "provider").map((row) => row.providerId);
    expect(providerIds).toEqual([...providerIds].sort());

    const garminRows = rows.filter((row) => row.providerId === "garmin");
    expect(garminRows.map((row) => row.scope)).toEqual(["provider", "user"]);
    expect(garminRows[1]?.userId).toBe("user-a");

    const stravaRows = rows.filter((row) => row.providerId === "strava");
    expect(stravaRows.map((row) => row.scope)).toEqual(["provider", "user"]);
  });

  it("sorts user-scoped rows by user id", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    for (const userId of ["user-b", "user-a"]) {
      redis.set(
        userCooldownKey("whoop", userId),
        JSON.stringify({
          providerId: "whoop",
          scope: "user",
          userId,
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      );
    }

    const rows = await getProviderRateLimitStatus(redis, now);
    const whoopUsers = rows
      .filter((row) => row.providerId === "whoop" && row.scope === "user")
      .map((row) => row.userId);
    expect(whoopUsers).toEqual(["user-a", "user-b"]);
  });

  it("skips user adaptive rows without meaningful state", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    const emptyState = createInitialAdaptiveState("whoop", "user", "user-1", now.getTime());
    redis.set(userAdaptiveKey("whoop", "user-1"), serializeAdaptiveRateState(emptyState));

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(
      rows.find(
        (row) => row.providerId === "whoop" && row.scope === "user" && row.userId === "user-1",
      ),
    ).toBeUndefined();
  });

  it.each([
    ["request count", { requestCount: 3 }],
    ["inferred budget", { inferredBudget: 10 }],
    ["observed cooldown", { observedCooldownSeconds: 120 }],
    ["adaptive throttle", { throttleMs: 5_000 }],
    ["strava short quota", { stravaShortLimit: 100, stravaShortUsage: 10 }],
    ["strava daily quota", { stravaDailyLimit: 1_000, stravaDailyUsage: 50 }],
  ] as const)("includes user adaptive rows with meaningful %s", async (_label, overrides) => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    const state = {
      ...createInitialAdaptiveState("whoop", "user", "user-9", now.getTime()),
      ...overrides,
    };
    redis.set(userAdaptiveKey("whoop", "user-9"), serializeAdaptiveRateState(state));

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(
      rows.find(
        (row) => row.providerId === "whoop" && row.scope === "user" && row.userId === "user-9",
      ),
    ).toMatchObject({ hasLiveState: true, throttleMs: state.throttleMs });
  });

  it("ignores invalid adaptive payloads and malformed keys", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    redis.set(providerAdaptiveKey("garmin"), "{not-valid-json");
    redis.set("provider-adaptive-rate:only-provider", "{}");
    redis.set(
      userAdaptiveKey("whoop", "unknown"),
      serializeAdaptiveRateState(
        createInitialAdaptiveState("whoop", "user", "unknown", now.getTime()),
      ),
    );

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(rows.find((row) => row.providerId === "garmin" && row.hasLiveState)).toBeUndefined();
    expect(rows.find((row) => row.scope === "user" && row.userId == null)).toBeUndefined();
  });

  it("ignores expired cooldowns and invalid cooldown payloads", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    redis.set(
      userCooldownKey("garmin", "expired-user"),
      JSON.stringify({
        providerId: "garmin",
        scope: "user",
        userId: "expired-user",
        expiresAt: now.toISOString(),
      }),
    );
    redis.set(userCooldownKey("whoop", "bad-json"), JSON.stringify({ providerId: 123 }));
    redis.set(
      userCooldownKey("whoop", "unknown"),
      JSON.stringify({
        providerId: "whoop",
        scope: "user",
        userId: "unknown",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(
      rows.find((row) => row.providerId === "garmin" && row.userId === "expired-user"),
    ).toBeUndefined();
    expect(
      rows.find((row) => row.providerId === "whoop" && row.userId === "bad-json"),
    ).toBeUndefined();
    expect(
      rows.find((row) => row.providerId === "whoop" && row.userId === "unknown"),
    ).toBeUndefined();
  });

  it("adds provider cooldowns and unconfigured providers discovered in redis", async () => {
    const redis = new MockRedisReader();
    const now = new Date("2026-06-22T12:00:00.000Z");
    const customState = {
      ...createInitialAdaptiveState("custom-provider", "provider", null, now.getTime()),
      requestCount: 2,
      throttleMs: defaultThrottleMs("custom-provider"),
    };
    redis.set(providerAdaptiveKey("custom-provider"), serializeAdaptiveRateState(customState));
    redis.set(
      "provider-rate-limit:strava:provider",
      JSON.stringify({
        providerId: "strava",
        scope: "provider",
        userId: null,
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      }),
    );

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(
      rows.find((row) => row.providerId === "custom-provider" && row.scope === "provider"),
    ).toMatchObject({
      requestCount: 2,
      syncTier: "frequent",
      hasLiveState: true,
    });
    expect(
      rows.find((row) => row.providerId === "strava" && row.scope === "provider"),
    ).toMatchObject({
      cooldownExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
      consecutiveHits: null,
      hasLiveState: true,
    });
  });

  it("follows paginated redis scan cursors", async () => {
    const redis = new PaginatedMockRedisReader([
      ["1", [providerAdaptiveKey("garmin")]],
      ["0", [providerAdaptiveKey("whoop")]],
    ]);
    const now = new Date("2026-06-22T12:00:00.000Z");
    const garminState = {
      ...createInitialAdaptiveState("garmin", "provider", null, now.getTime()),
      requestCount: 4,
    };
    const whoopState = {
      ...createInitialAdaptiveState("whoop", "provider", null, now.getTime()),
      requestCount: 2,
    };
    redis.set(providerAdaptiveKey("garmin"), serializeAdaptiveRateState(garminState));
    redis.set(providerAdaptiveKey("whoop"), serializeAdaptiveRateState(whoopState));

    const rows = await getProviderRateLimitStatus(redis, now);
    expect(rows.find((row) => row.providerId === "garmin" && row.requestCount === 4)).toBeTruthy();
    expect(rows.find((row) => row.providerId === "whoop" && row.requestCount === 2)).toBeTruthy();
  });
});

describe("getProviderRateLimitStatusFromRedis", () => {
  beforeEach(() => {
    sharedRedisMocks.get.mockResolvedValue(null);
    sharedRedisMocks.scan.mockResolvedValue(["0", []]);
    sharedRedisMocks.RedisConnection.mockImplementation(() => ({
      get client() {
        return Promise.resolve({
          get: sharedRedisMocks.get,
          scan: sharedRedisMocks.scan,
        });
      },
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("loads status through the shared redis reader", async () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const adaptiveState = {
      ...createInitialAdaptiveState("garmin", "provider", null, now.getTime()),
      requestCount: 7,
      throttleMs: 3_000,
    };
    sharedRedisMocks.get.mockImplementation(async (key) =>
      key === providerAdaptiveKey("garmin") ? serializeAdaptiveRateState(adaptiveState) : null,
    );
    sharedRedisMocks.scan.mockResolvedValue(["0", [providerAdaptiveKey("garmin")]]);

    const { getProviderRateLimitStatusFromRedis } = await import("./provider-rate-limit-status.ts");
    const rows = await getProviderRateLimitStatusFromRedis(now);

    expect(
      rows.find((row) => row.providerId === "garmin" && row.scope === "provider"),
    ).toMatchObject({
      requestCount: 7,
      throttleMs: 3_000,
      hasLiveState: true,
    });
    expect(sharedRedisMocks.RedisConnection).toHaveBeenCalledTimes(1);
    expect(sharedRedisMocks.scan).toHaveBeenCalled();
  });
});
