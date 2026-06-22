import { serializeAdaptiveRateState } from "@dofek/provider-http/adaptive-rate-limit";
import { describe, expect, it } from "vitest";
import { getProviderRateLimitStatus } from "./provider-rate-limit-status.ts";

interface MockRedisEntry {
  value: string | null;
  expiresAtMs?: number;
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
    const regex = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
    const keys = [...this.#entries.keys()].filter((key) => regex.test(key));
    if (cursor !== "0") return ["0", []];
    return ["0", keys];
  }
}

describe("getProviderRateLimitStatus", () => {
  it("returns configured provider rows with static queue limits", async () => {
    const redis = new MockRedisReader();
    const rows = await getProviderRateLimitStatus(redis);

    const strava = rows.find((row) => row.providerId === "strava" && row.scope === "provider");
    expect(strava).toMatchObject({
      providerId: "strava",
      scope: "provider",
      syncTier: "realtime",
      queueLimiterMax: 90,
      queueLimiterDurationMs: 15 * 60_000,
      defaultThrottleMs: 10_000,
      hasLiveState: false,
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
    redis.set("provider-adaptive-rate:garmin:provider", serializeAdaptiveRateState(adaptiveState));
    redis.set(
      "provider-rate-limit:garmin:user:user-42",
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
      hasLiveState: true,
    });
    expect(userRow).toMatchObject({
      cooldownExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      consecutiveHits: 2,
      hasLiveState: true,
    });
  });
});
