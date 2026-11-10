import { randomUUID } from "node:crypto";
import {
  adaptiveRateLimitStorageKey,
  createInitialAdaptiveState,
  parseAdaptiveRateState,
} from "@dofek/provider-http/adaptive-rate-limit";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSharedRedisConnection } from "../jobs/queues.ts";
import { RedisAdaptiveRateLimitStore } from "./provider-adaptive-rate-limit.ts";

describe("Redis adaptive admission concurrency", () => {
  const store = new RedisAdaptiveRateLimitStore();
  const keys: string[] = [];

  beforeEach(() => {
    if (!process.env.REDIS_URL)
      throw new Error("REDIS_URL is required for Redis integration tests");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const redis = await getSharedRedisConnection().client;
    if (keys.length) await redis.del(...keys.splice(0));
  });

  afterAll(async () => {
    await getSharedRedisConnection().close();
  });

  it.each(["provider", "user"] as const)(
    "paces and counts concurrent %s admissions sharing a Redis connection",
    async (scope) => {
      const providerId = `catalogue-${randomUUID()}`;
      const userId = scope === "user" ? "owner" : null;
      const key = adaptiveRateLimitStorageKey(providerId, scope, userId);
      keys.push(key);
      const admittedAt: number[] = [];

      await Promise.all(
        Array.from({ length: 4 }, async () => {
          await store.awaitAdmission(providerId, scope, userId);
          admittedAt.push(Date.now());
          await store.recordSuccess(providerId, scope, userId);
        }),
      );

      const redis = await getSharedRedisConnection().client;
      const state = parseAdaptiveRateState(await redis.get(key));
      expect(state?.requestCount).toBe(4);
      // Existing pacing is 900/800/700ms, allowing 50ms of timing variation per gap.
      admittedAt.sort((a, b) => a - b);
      for (const [index, minimumGap] of [850, 750, 650].entries()) {
        const earlier = admittedAt[index];
        const later = admittedAt[index + 1];
        if (earlier === undefined || later === undefined)
          throw new Error("Expected four completed admissions");
        expect(later - earlier).toBeGreaterThanOrEqual(minimumGap);
      }
      expect(await redis.eval("return redis.call('PTTL', KEYS[1])", 1, key)).toBeGreaterThan(0);
    },
  );

  it("preserves rate-limit learning when successful responses arrive concurrently", async () => {
    const providerId = `catalogue-${randomUUID()}`;
    const key = adaptiveRateLimitStorageKey(providerId, "provider", null);
    keys.push(key);
    const redis = await getSharedRedisConnection().client;
    await redis.set(
      key,
      JSON.stringify({
        ...createInitialAdaptiveState(providerId, "provider", null),
        requestCount: 12,
      }),
    );

    await Promise.all([
      store.recordRateLimit(
        new ProviderRateLimitError({
          message: "rate limited",
          providerId,
          statusCode: 429,
          responseBody: "limited",
          retryAfterSeconds: 60,
        }),
      ),
      store.recordSuccess(providerId, "provider", null),
    ]);

    const state = parseAdaptiveRateState(await redis.get(key));
    expect(state).toMatchObject({
      requestCount: 12,
      throttleMs: 2_000,
      inferredBudget: 11,
      observedCooldownSeconds: 60,
    });
  });
});
