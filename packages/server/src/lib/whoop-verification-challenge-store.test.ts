import { describe, expect, it, vi } from "vitest";
import {
  InMemoryWhoopVerificationChallengeStore,
  RedisWhoopVerificationChallengeStore,
} from "./whoop-verification-challenge-store.ts";

describe("InMemoryWhoopVerificationChallengeStore", () => {
  it("stores, loads, and deletes challenge sessions", async () => {
    const challengeStore = new InMemoryWhoopVerificationChallengeStore();

    await challengeStore.save("challenge-1", {
      session: "session-abc",
      method: "sms",
      username: "user@example.com",
      expiresAt: Date.now() + 60_000,
      userId: "user-123",
    });

    expect(await challengeStore.get("challenge-1")).toEqual({
      session: "session-abc",
      method: "sms",
      username: "user@example.com",
      expiresAt: expect.any(Number),
      userId: "user-123",
    });

    await challengeStore.delete("challenge-1");
    expect(await challengeStore.get("challenge-1")).toBeNull();
  });

  it("expires challenge sessions after ttl", async () => {
    vi.useFakeTimers();
    try {
      const challengeStore = new InMemoryWhoopVerificationChallengeStore();

      await challengeStore.save(
        "challenge-expiring",
        {
          session: "session-expiring",
          method: "sms",
          username: "user@example.com",
          expiresAt: Date.now() + 100,
          userId: "user-123",
        },
        100,
      );

      vi.advanceTimersByTime(101);
      expect(await challengeStore.get("challenge-expiring")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RedisWhoopVerificationChallengeStore", () => {
  it("persists challenges in redis format and loads them back", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () =>
      JSON.stringify({
        session: "session-from-redis",
        method: "sms",
        username: "user@example.com",
        expiresAt: 12345,
        userId: "user-123",
      }),
    );
    const deleteMethod = vi.fn(async () => 1);

    const challengeStore = new RedisWhoopVerificationChallengeStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
    }));

    await challengeStore.save("challenge-redis", {
      session: "session-from-redis",
      method: "sms",
      username: "user@example.com",
      expiresAt: 12345,
      userId: "user-123",
    });

    expect(setMethod).toHaveBeenCalledWith(
      "whoop:verification:challenge-redis",
      expect.any(String),
      "PX",
      600_000,
    );

    const loadedChallenge = await challengeStore.get("challenge-redis");
    expect(loadedChallenge).toEqual({
      session: "session-from-redis",
      method: "sms",
      username: "user@example.com",
      expiresAt: 12345,
      userId: "user-123",
    });

    await challengeStore.delete("challenge-redis");
    expect(deleteMethod).toHaveBeenCalledWith("whoop:verification:challenge-redis");
  });

  it("returns null when redis has no challenge payload", async () => {
    const challengeStore = new RedisWhoopVerificationChallengeStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
    }));

    await expect(challengeStore.get("missing-challenge")).resolves.toBeNull();
  });

  it("returns null and deletes the key when redis returns invalid JSON", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () => "{invalid json");
    const deleteMethod = vi.fn(async () => 1);

    const challengeStore = new RedisWhoopVerificationChallengeStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
    }));

    const result = await challengeStore.get("challenge-redis-invalid-json");

    expect(result).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("whoop:verification:challenge-redis-invalid-json");
  });

  it("deletes invalid challenge payloads from redis", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const challengeStore = new RedisWhoopVerificationChallengeStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => JSON.stringify({ session: "incomplete" })),
      del: deleteMethod,
    }));

    await expect(challengeStore.get("invalid-challenge")).resolves.toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("whoop:verification:invalid-challenge");
  });

  it("uses shared redis connection outside test environment", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const redisSet = vi.fn(async () => "OK" as const);
    const redisGet = vi.fn(async () =>
      JSON.stringify({
        session: "shared-session",
        method: "sms",
        username: "user@example.com",
        expiresAt: 1234,
        userId: "user-456",
      }),
    );
    const redisDelete = vi.fn(async () => 1);
    let capturedConnectionOptions: unknown;
    let capturedRedisConnectionOptions: unknown;

    class MockRedisConnection {
      readonly client: Promise<{
        set: typeof redisSet;
        get: typeof redisGet;
        del: typeof redisDelete;
      }>;

      constructor(connectionOptions: unknown, redisConnectionOptions: unknown) {
        capturedConnectionOptions = connectionOptions;
        capturedRedisConnectionOptions = redisConnectionOptions;
        this.client = Promise.resolve({
          set: redisSet,
          get: redisGet,
          del: redisDelete,
        });
      }
    }

    const getRedisConnection = vi.fn(() => ({
      host: "localhost",
      port: 6379,
    }));

    process.env.NODE_ENV = "production";
    vi.resetModules();
    vi.doMock("bullmq", () => ({ RedisConnection: MockRedisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection }));

    try {
      const challengeStoreModule = await import("./whoop-verification-challenge-store.ts");
      const challengeStore = challengeStoreModule.getWhoopVerificationChallengeStore();

      await challengeStore.save("challenge-shared", {
        session: "shared-session",
        method: "sms",
        username: "user@example.com",
        expiresAt: 1234,
        userId: "user-456",
      });
      await expect(challengeStore.get("challenge-shared")).resolves.toEqual({
        session: "shared-session",
        method: "sms",
        username: "user@example.com",
        expiresAt: 1234,
        userId: "user-456",
      });
      await challengeStore.delete("challenge-shared");

      expect(getRedisConnection).toHaveBeenCalledTimes(1);
      expect(capturedConnectionOptions).toEqual({
        host: "localhost",
        port: 6379,
      });
      expect(capturedRedisConnectionOptions).toEqual({
        shared: true,
        blocking: false,
        skipVersionCheck: true,
      });
      expect(redisSet).toHaveBeenCalledWith(
        "whoop:verification:challenge-shared",
        expect.any(String),
        "PX",
        600_000,
      );
      expect(redisDelete).toHaveBeenCalledWith("whoop:verification:challenge-shared");
    } finally {
      vi.resetModules();
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
