import { RedisCacheStore } from "dofek/lib/cache";
import { beforeEach, describe, expect, it } from "vitest";

function createFakeRedisClient() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const mgetBatches: string[][] = [];
  const sremBatches: string[][] = [];

  return {
    client: {
      async set(key: string, value: string): Promise<"OK"> {
        values.set(key, value);
        return "OK";
      },
      async get(key: string): Promise<string | null> {
        return values.get(key) ?? null;
      },
      async mget(...keys: string[]): Promise<Array<string | null>> {
        mgetBatches.push(keys);
        return keys.map((key) => values.get(key) ?? null);
      },
      async del(...keys: string[]): Promise<number> {
        let deleted = 0;
        for (const key of keys) {
          if (values.delete(key)) deleted++;
        }
        return deleted;
      },
      async sadd(key: string, ...members: string[]): Promise<number> {
        let set = sets.get(key);
        if (!set) {
          set = new Set<string>();
          sets.set(key, set);
        }
        const before = set.size;
        for (const member of members) set.add(member);
        return set.size - before;
      },
      async smembers(key: string): Promise<string[]> {
        return [...(sets.get(key) ?? new Set<string>())];
      },
      async srem(key: string, ...members: string[]): Promise<number> {
        sremBatches.push(members);
        const set = sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const member of members) {
          if (set.delete(member)) removed++;
        }
        return removed;
      },
    },
    values,
    sets,
    mgetBatches,
    sremBatches,
  };
}

describe("RedisCacheStore", () => {
  const fakeRedis = createFakeRedisClient();
  const store = new RedisCacheStore(async () => fakeRedis.client);

  beforeEach(async () => {
    fakeRedis.values.clear();
    fakeRedis.sets.clear();
    fakeRedis.mgetBatches.length = 0;
    fakeRedis.sremBatches.length = 0;
    await store.invalidateAll();
  });

  it("stores and retrieves serialized values", async () => {
    await store.set("user-1:dashboard", { value: 42, items: ["a", "b"] }, 60_000);

    expect(await store.get("user-1:dashboard")).toEqual({ value: 42, items: ["a", "b"] });
  });

  it("returns undefined for missing keys", async () => {
    expect(await store.get("missing")).toBeUndefined();
  });

  it("lists registered keys with an optional prefix", async () => {
    await store.set("user-1:cycling.performance:UTC:{}", "one", 60_000);
    await store.set("user-1:sleep.list:UTC:{}", "two", 60_000);

    await expect(store.listKeys("user-1:cycling.")).resolves.toEqual([
      "user-1:cycling.performance:UTC:{}",
    ]);
  });

  it("checks and removes registered keys in bounded batches", async () => {
    const registeredKeys = Array.from(
      { length: 1001 },
      (_, index) => `query-cache:data:user-1:cycling.performance:UTC:${index}`,
    );
    await fakeRedis.client.sadd("query-cache:keys", ...registeredKeys);

    await expect(store.listKeys("user-1:cycling.")).resolves.toEqual([]);

    expect(fakeRedis.mgetBatches.map((batch) => batch.length)).toEqual([1000, 1]);
    expect(fakeRedis.sremBatches.map((batch) => batch.length)).toEqual([1000, 1]);
  });

  it.each([
    "",
    "{bad json",
    '{"incomplete":',
  ])("evicts malformed payload %s and treats it as a cache miss", async (malformedPayload) => {
    await fakeRedis.client.set("query-cache:data:user-1:sync.dataHealth:{}", malformedPayload);
    await fakeRedis.client.sadd("query-cache:keys", "query-cache:data:user-1:sync.dataHealth:{}");

    expect(await store.get("user-1:sync.dataHealth:{}")).toBeUndefined();
    expect(fakeRedis.values.has("query-cache:data:user-1:sync.dataHealth:{}")).toBe(false);
    expect(
      fakeRedis.sets.get("query-cache:keys")?.has("query-cache:data:user-1:sync.dataHealth:{}"),
    ).toBe(false);
  });
  it("invalidateByPrefix removes only matching keys", async () => {
    await store.set("user1:food.byDate:{}", "data1", 60_000);
    await store.set("user1:food.dailyTotals:{}", "data2", 60_000);
    await store.set("user1:nutrition.daily:{}", "data3", 60_000);
    await store.set("user2:food.byDate:{}", "data4", 60_000);

    await store.invalidateByPrefix("user1:food.");

    expect(await store.get("user1:food.byDate:{}")).toBeUndefined();
    expect(await store.get("user1:food.dailyTotals:{}")).toBeUndefined();
    expect(await store.get("user1:nutrition.daily:{}")).toBe("data3");
    expect(await store.get("user2:food.byDate:{}")).toBe("data4");
  });

  it("invalidateAll clears every cached key", async () => {
    await store.set("a", 1, 60_000);
    await store.set("b", 2, 60_000);

    await store.invalidateAll();

    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeUndefined();
  });
});
