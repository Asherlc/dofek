import { describe, expect, it, vi } from "vitest";
import {
  getIdentityFlowStore,
  type IdentityFlowEntry,
  InMemoryIdentityFlowStore,
  RedisIdentityFlowStore,
} from "./identity-flow-store.ts";

const sampleEntry: IdentityFlowEntry = {
  codeVerifier: "verifier-abc",
  linkUserId: "user-123",
  mobileScheme: "dofek",
  returnTo: "/settings",
};

describe("InMemoryIdentityFlowStore", () => {
  it("stores, retrieves, and deletes a flow entry", async () => {
    const store = new InMemoryIdentityFlowStore();

    await store.save("state-1", sampleEntry);
    expect(await store.get("state-1")).toEqual(sampleEntry);

    await store.delete("state-1");
    expect(await store.get("state-1")).toBeNull();
  });

  it("returns null for a missing key", async () => {
    const store = new InMemoryIdentityFlowStore();
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryIdentityFlowStore();
      await store.save("state-expiring", sampleEntry, 100);

      vi.advanceTimersByTime(101);
      expect(await store.get("state-expiring")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores entries without optional fields", async () => {
    const store = new InMemoryIdentityFlowStore();
    const minimalEntry: IdentityFlowEntry = { codeVerifier: "verifier-only" };

    await store.save("state-minimal", minimalEntry);
    expect(await store.get("state-minimal")).toEqual(minimalEntry);
  });
});

describe("RedisIdentityFlowStore", () => {
  it("saves entries to Redis with TTL and retrieves them", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () => JSON.stringify(sampleEntry));
    const deleteMethod = vi.fn(async () => 1);

    const store = new RedisIdentityFlowStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
    }));

    await store.save("state-redis", sampleEntry);
    expect(setMethod).toHaveBeenCalledWith(
      "identity-flow:state-redis",
      JSON.stringify(sampleEntry),
      "PX",
      600_000,
    );

    const loaded = await store.get("state-redis");
    expect(loaded).toEqual(sampleEntry);
  });

  it("returns null when Redis has no entry", async () => {
    const store = new RedisIdentityFlowStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
    }));

    expect(await store.get("missing")).toBeNull();
  });

  it("returns null and deletes the key on invalid JSON", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisIdentityFlowStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => "{invalid json"),
      del: deleteMethod,
    }));

    expect(await store.get("bad-json")).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("identity-flow:bad-json");
  });

  it("returns null and deletes the key when schema validation fails", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisIdentityFlowStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => JSON.stringify({ unexpected: "shape" })),
      del: deleteMethod,
    }));

    expect(await store.get("bad-schema")).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("identity-flow:bad-schema");
  });

  it("deletes entries from Redis", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisIdentityFlowStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: deleteMethod,
    }));

    await store.delete("state-to-delete");
    expect(deleteMethod).toHaveBeenCalledWith("identity-flow:state-to-delete");
  });

  it("saves entries without optional fields", async () => {
    const setMethod = vi.fn(async () => "OK");
    const minimalEntry: IdentityFlowEntry = { codeVerifier: "verifier-only" };
    const store = new RedisIdentityFlowStore(async () => ({
      set: setMethod,
      get: vi.fn(async () => JSON.stringify(minimalEntry)),
      del: vi.fn(async () => 0),
    }));

    await store.save("state-minimal", minimalEntry);
    expect(setMethod).toHaveBeenCalledWith(
      "identity-flow:state-minimal",
      JSON.stringify(minimalEntry),
      "PX",
      600_000,
    );

    const loaded = await store.get("state-minimal");
    expect(loaded).toEqual(minimalEntry);
  });

  it("respects custom TTL", async () => {
    const setMethod = vi.fn(async () => "OK");
    const store = new RedisIdentityFlowStore(async () => ({
      set: setMethod,
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
    }));

    await store.save("state-custom-ttl", sampleEntry, 30_000);
    expect(setMethod).toHaveBeenCalledWith(
      "identity-flow:state-custom-ttl",
      expect.any(String),
      "PX",
      30_000,
    );
  });
});

describe("getIdentityFlowStore", () => {
  it("returns InMemoryIdentityFlowStore in test environment", () => {
    const store = getIdentityFlowStore();
    expect(store).toBeInstanceOf(InMemoryIdentityFlowStore);
  });

  it("uses shared Redis connection outside test environment", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const redisSet = vi.fn(async () => "OK" as const);
    const redisGet = vi.fn(async () => JSON.stringify({ codeVerifier: "v", linkUserId: "u1" }));
    const redisDel = vi.fn(async () => 1);

    class MockRedisConnection {
      readonly client: Promise<{
        set: typeof redisSet;
        get: typeof redisGet;
        del: typeof redisDel;
      }>;
      constructor() {
        this.client = Promise.resolve({ set: redisSet, get: redisGet, del: redisDel });
      }
    }

    const getRedisConnection = vi.fn(() => ({ host: "localhost", port: 6379 }));

    process.env.NODE_ENV = "production";
    vi.resetModules();
    vi.doMock("bullmq", () => ({ RedisConnection: MockRedisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection }));

    try {
      const mod = await import("./identity-flow-store.ts");
      const store = mod.getIdentityFlowStore();
      expect(store).toBeInstanceOf(mod.RedisIdentityFlowStore);

      await store.save("s1", { codeVerifier: "v", linkUserId: "u1" });
      expect(redisSet).toHaveBeenCalledWith("identity-flow:s1", expect.any(String), "PX", 600_000);

      const loaded = await store.get("s1");
      expect(loaded).toEqual({ codeVerifier: "v", linkUserId: "u1" });

      await store.delete("s1");
      expect(redisDel).toHaveBeenCalledWith("identity-flow:s1");
    } finally {
      vi.resetModules();
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
