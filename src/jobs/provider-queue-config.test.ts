import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUE_CONFIG,
  SYNC_WORKER_LOCK_DURATION_MS,
  buildSyncWorkerOptions,
  getConfiguredProviderIds,
  getProviderQueueConfig,
  type ProviderSyncTier,
} from "./provider-queue-config.ts";

describe("getProviderQueueConfig", () => {
  it("returns strava-specific config with rate limiter", () => {
    const config = getProviderQueueConfig("strava");
    expect(config.limiter).toBeDefined();
    expect(config.limiter?.max).toBe(90);
    expect(config.limiter?.duration).toBe(900_000); // 15 minutes
    expect(config.concurrency).toBe(2);
    expect(config.syncTier).toBe("realtime");
  });

  it("returns withings-specific config with rate limiter", () => {
    const config = getProviderQueueConfig("withings");
    expect(config.limiter).toBeDefined();
    expect(config.limiter?.max).toBe(120);
    expect(config.limiter?.duration).toBe(60_000); // 1 minute
    expect(config.syncTier).toBe("realtime");
  });

  it("returns fitbit-specific config with rate limiter", () => {
    const config = getProviderQueueConfig("fitbit");
    expect(config.limiter).toBeDefined();
    expect(config.limiter?.max).toBe(150);
    expect(config.limiter?.duration).toBe(3_600_000); // 1 hour
    expect(config.syncTier).toBe("frequent");
  });

  it("returns default config for unknown provider", () => {
    const config = getProviderQueueConfig("unknown-provider-xyz");
    expect(config).toEqual(DEFAULT_QUEUE_CONFIG);
    expect(config.limiter).toBeUndefined();
    expect(config.concurrency).toBe(3);
    expect(config.syncTier).toBe("frequent");
  });

  it("returns on-demand tier for bodyspec", () => {
    const config = getProviderQueueConfig("bodyspec");
    expect(config.syncTier).toBe("on-demand");
    expect(config.concurrency).toBe(1);
  });

  it("returns daily tier for fatsecret", () => {
    const config = getProviderQueueConfig("fatsecret");
    expect(config.syncTier).toBe("daily");
  });

  it("returns realtime tier for garmin", () => {
    const config = getProviderQueueConfig("garmin");
    expect(config.syncTier).toBe("realtime");
    expect(config.limiter).toBeUndefined();
    expect(config.concurrency).toBe(3);
  });

  it("returns frequent tier for whoop", () => {
    const config = getProviderQueueConfig("whoop");
    expect(config.syncTier).toBe("frequent");
  });
});

describe("config values are reasonable", () => {
  it("all configs have positive concurrency", () => {
    for (const id of getConfiguredProviderIds()) {
      const config = getProviderQueueConfig(id);
      expect(config.concurrency, `${id} concurrency`).toBeGreaterThan(0);
    }
  });

  it("all rate limiters have positive max and duration", () => {
    for (const id of getConfiguredProviderIds()) {
      const config = getProviderQueueConfig(id);
      if (config.limiter) {
        expect(config.limiter.max, `${id} limiter.max`).toBeGreaterThan(0);
        expect(config.limiter.duration, `${id} limiter.duration`).toBeGreaterThan(0);
      }
    }
  });

  it("all configs have a valid sync tier", () => {
    const validTiers: ProviderSyncTier[] = ["realtime", "frequent", "daily", "on-demand"];
    for (const id of getConfiguredProviderIds()) {
      const config = getProviderQueueConfig(id);
      expect(validTiers, `${id} tier`).toContain(config.syncTier);
    }
  });
});

describe("buildSyncWorkerOptions", () => {
  const fakeConnection = { host: "localhost" };

  it("includes lockDuration for all providers", () => {
    const options = buildSyncWorkerOptions("strava", fakeConnection);
    expect(options.lockDuration).toBe(SYNC_WORKER_LOCK_DURATION_MS);
    expect(options.lockDuration).toBe(300_000);
  });

  it("passes connection through", () => {
    const options = buildSyncWorkerOptions("garmin", fakeConnection);
    expect(options.connection).toBe(fakeConnection);
  });

  it("uses provider-specific concurrency", () => {
    const stravaOptions = buildSyncWorkerOptions("strava", fakeConnection);
    expect(stravaOptions.concurrency).toBe(2);

    const garminOptions = buildSyncWorkerOptions("garmin", fakeConnection);
    expect(garminOptions.concurrency).toBe(3);
  });

  it("includes rate limiter when provider has one", () => {
    const options = buildSyncWorkerOptions("strava", fakeConnection);
    expect(options.limiter).toBeDefined();
    expect(options.limiter?.max).toBe(90);
  });

  it("omits rate limiter when provider has none", () => {
    const options = buildSyncWorkerOptions("garmin", fakeConnection);
    expect(options.limiter).toBeUndefined();
  });

  it("falls back to default config for unknown provider", () => {
    const options = buildSyncWorkerOptions("unknown-xyz", fakeConnection);
    expect(options.concurrency).toBe(DEFAULT_QUEUE_CONFIG.concurrency);
    expect(options.lockDuration).toBe(300_000);
  });
});

describe("getConfiguredProviderIds", () => {
  it("returns all known provider IDs", () => {
    const ids = getConfiguredProviderIds();
    expect(ids.length).toBeGreaterThan(20);
    expect(ids).toContain("strava");
    expect(ids).toContain("garmin");
    expect(ids).toContain("whoop");
    expect(ids).toContain("fatsecret");
    expect(ids).toContain("bodyspec");
  });

  it("does not contain duplicates", () => {
    const ids = getConfiguredProviderIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
