import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("cache module environment selection", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("bullmq");
    vi.doUnmock("dofek/jobs/queues");
    process.env = { ...originalEnv };
  });

  it("uses NullCacheStore when query cache is disabled", async () => {
    process.env = { ...originalEnv, DISABLE_QUERY_CACHE: "true", NODE_ENV: "production" };

    const module = await import("./cache.ts");

    expect(module.queryCache).toBeInstanceOf(module.NullCacheStore);
  });

  it("uses MemoryCacheStore in test env", async () => {
    process.env = { ...originalEnv, NODE_ENV: "test" };

    const module = await import("./cache.ts");

    expect(module.queryCache).toBeInstanceOf(module.MemoryCacheStore);
  });

  it("uses a shared Redis client in production env", async () => {
    const client = {
      set: vi.fn(async () => "OK" as const),
      get: vi.fn(async () => JSON.stringify({ ok: true })),
      del: vi.fn(async () => 1),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => ["query-cache:data:user-1:dashboard"]),
      srem: vi.fn(async () => 1),
    };
    const redisConnection = vi.fn().mockImplementation(() => ({
      client: Promise.resolve(client),
    }));
    const getRedisConnection = vi.fn(() => ({ host: "redis" }));

    vi.doMock("bullmq", () => ({ RedisConnection: redisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection }));
    process.env = { ...originalEnv, NODE_ENV: "production" };

    const module = await import("./cache.ts");
    const store = new module.RedisCacheStore();

    await store.set("user-1:dashboard", { ok: true }, 60_000);
    await expect(store.get("user-1:dashboard")).resolves.toEqual({ ok: true });
    await store.invalidateAll();

    expect(getRedisConnection).toHaveBeenCalledTimes(1);
    expect(redisConnection).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith(
      "query-cache:data:user-1:dashboard",
      JSON.stringify({ ok: true }),
      "PX",
      60_000,
    );
    expect(client.sadd).toHaveBeenCalledWith(
      "query-cache:keys",
      "query-cache:data:user-1:dashboard",
    );
    expect(client.smembers).toHaveBeenCalledWith("query-cache:keys");
    expect(client.del).toHaveBeenCalledWith("query-cache:data:user-1:dashboard");
    expect(client.srem).toHaveBeenCalledWith(
      "query-cache:keys",
      "query-cache:data:user-1:dashboard",
    );
  });
});
