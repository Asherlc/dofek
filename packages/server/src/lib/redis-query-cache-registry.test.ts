import { beforeEach, describe, expect, it, vi } from "vitest";

interface RedisMockState {
  client: object;
  RedisConnection: ReturnType<typeof vi.fn>;
}

const redisMocks = vi.hoisted<RedisMockState>(() => {
  const state: RedisMockState = {
    client: {},
    RedisConnection: vi.fn(function RedisConnection() {
      return {
        get client() {
          return Promise.resolve(state.client);
        },
      };
    }),
  };
  return state;
});

vi.mock("bullmq", () => ({ RedisConnection: redisMocks.RedisConnection }));

import { RedisQueryCacheRegistry } from "../../../../src/lib/redis-query-cache-registry.ts";

function createFakeRedisClient(values: Map<string, string>, registeredKeys: string[]) {
  const mgetBatches: string[][] = [];
  const removedBatches: string[][] = [];
  return {
    client: {
      async mget(...keys: string[]): Promise<Array<string | null>> {
        mgetBatches.push(keys);
        return keys.map((key) => values.get(key) ?? null);
      },
      async smembers(): Promise<string[]> {
        return registeredKeys;
      },
      async srem(_key: string, ...members: string[]): Promise<number> {
        removedBatches.push(members);
        return members.length;
      },
    },
    mgetBatches,
    removedBatches,
  };
}

describe("RedisQueryCacheRegistry", () => {
  beforeEach(() => {
    redisMocks.RedisConnection.mockClear();
  });

  it("lists live registered keys matching the optional prefix", async () => {
    const cyclingKey = "query-cache:data:user-1:cycling.performance:UTC:{}";
    const sleepKey = "query-cache:data:user-1:sleep.list:UTC:{}";
    const fakeRedis = createFakeRedisClient(
      new Map([
        [cyclingKey, '"cycling"'],
        [sleepKey, '"sleep"'],
      ]),
      [cyclingKey, sleepKey, "unrelated:key"],
    );
    const registry = new RedisQueryCacheRegistry(async () => fakeRedis.client);

    await expect(registry.listKeys("user-1:cycling.")).resolves.toEqual([
      "user-1:cycling.performance:UTC:{}",
    ]);
    expect(fakeRedis.removedBatches).toEqual([]);
  });

  it("checks and removes expired registrations in bounded batches", async () => {
    const registeredKeys = Array.from(
      { length: 1001 },
      (_, index) => `query-cache:data:user-1:cycling.performance:UTC:${index}`,
    );
    const fakeRedis = createFakeRedisClient(new Map(), registeredKeys);
    const registry = new RedisQueryCacheRegistry(async () => fakeRedis.client);

    await expect(registry.listKeys()).resolves.toEqual([]);
    expect(fakeRedis.mgetBatches.map((batch) => batch.length)).toEqual([1000, 1]);
    expect(fakeRedis.removedBatches.map((batch) => batch.length)).toEqual([1000, 1]);
  });

  it("does not query payloads when no registrations match", async () => {
    const fakeRedis = createFakeRedisClient(new Map(), [
      "query-cache:data:user-1:sleep.list:UTC:{}",
    ]);
    const registry = new RedisQueryCacheRegistry(async () => fakeRedis.client);

    await expect(registry.listKeys("user-1:cycling.")).resolves.toEqual([]);
    expect(fakeRedis.mgetBatches).toEqual([]);
  });

  it("uses the shared production Redis connection", async () => {
    const fakeRedis = createFakeRedisClient(
      new Map([["query-cache:data:user-1:cycling.performance:UTC:{}", '"cycling"']]),
      ["query-cache:data:user-1:cycling.performance:UTC:{}"],
    );
    redisMocks.client = fakeRedis.client;

    await expect(new RedisQueryCacheRegistry().listKeys()).resolves.toEqual([
      "user-1:cycling.performance:UTC:{}",
    ]);
    await new RedisQueryCacheRegistry().listKeys();
    expect(redisMocks.RedisConnection).toHaveBeenCalledTimes(1);
    expect(redisMocks.RedisConnection).toHaveBeenCalledWith(expect.any(Object), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  });

  it.each(["mget", "smembers", "srem"])(
    "fails loudly when the Redis client does not support %s",
    async (missingCommand) => {
      redisMocks.client = {
        mget: vi.fn(),
        smembers: vi.fn(),
        srem: vi.fn(),
        [missingCommand]: undefined,
      };

      await expect(new RedisQueryCacheRegistry().listKeys()).rejects.toThrow(
        "Redis client does not support query-cache registry commands",
      );
    },
  );
});
