import { beforeEach, describe, expect, it } from "vitest";
import { RedisCacheStore } from "dofek/lib/cache";

function createFakeRedisClient() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  return {
    client: {
      async set(key: string, value: string): Promise<"OK"> {
        values.set(key, value);
        return "OK";
      },
      async get(key: string): Promise<string | null> {
        return values.get(key) ?? null;
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
  };
}

describe("RedisCacheStore", () => {
  const fakeRedis = createFakeRedisClient();
  const store = new RedisCacheStore(async () => fakeRedis.client);

  beforeEach(async () => {
    fakeRedis.values.clear();
    fakeRedis.sets.clear();
    await store.invalidateAll();
  });

  it("stores and retrieves serialized values", async () => {
    await store.set("user-1:dashboard", { value: 42, items: ["a", "b"] }, 60_000);

    expect(await store.get("user-1:dashboard")).toEqual({ value: 42, items: ["a", "b"] });
  });

  it("returns undefined for missing keys", async () => {
    expect(await store.get("missing")).toBeUndefined();
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
