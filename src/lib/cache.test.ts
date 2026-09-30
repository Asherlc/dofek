import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CacheStore,
  invalidateAllQueries,
  invalidateAllUserQueries,
  invalidateUserQueryDomains,
  NullCacheStore,
  queryCache,
  RedisCacheStore,
} from "./cache.js";

const TTL_MS = 60_000;

afterEach(async () => {
  await queryCache.invalidateAll();
});

describe("query cache invalidation", () => {
  it("invalidates every prefix for the requested user domains", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-1:journal.trends", "trends", TTL_MS),
      queryCache.set("user-1:behaviorImpact.sleep", "impact", TTL_MS),
      queryCache.set("user-1:personalization.preferences", "preferences", TTL_MS),
      queryCache.set("user-1:mobileDashboard.summary", "dashboard", TTL_MS),
      queryCache.set("user-1:recovery.score", "recovery", TTL_MS),
      queryCache.set("user-1:stress.score", "stress", TTL_MS),
      queryCache.set("user-1:pmc.chart", "pmc", TTL_MS),
      queryCache.set("user-1:lifeEvents.timeline", "life events", TTL_MS),
      queryCache.set("user-2:journal.entries", "other user", TTL_MS),
    ]);

    await invalidateUserQueryDomains("user-1", ["journalEntries", "personalization"]);

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:journal.trends")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:behaviorImpact.sleep")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:personalization.preferences")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:mobileDashboard.summary")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:recovery.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:stress.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:pmc.chart")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:lifeEvents.timeline")).resolves.toBe("life events");
    await expect(queryCache.get("user-2:journal.entries")).resolves.toBe("other user");
  });

  it("invalidates every query belonging to one user", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-1:recovery.score", "recovery", TTL_MS),
      queryCache.set("user-2:journal.entries", "other user", TTL_MS),
    ]);

    await invalidateAllUserQueries("user-1");

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:recovery.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-2:journal.entries")).resolves.toBe("other user");
  });

  it("invalidates every cached query", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-2:recovery.score", "recovery", TTL_MS),
    ]);

    await invalidateAllQueries();

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-2:recovery.score")).resolves.toBeUndefined();
  });
});

it("invalidates exactly one key and preserves adjacent and other-user entries", async () => {
  const key = "user-1:activity.stream";
  await queryCache.set(key, "removed", TTL_MS);
  await queryCache.set(`${key}:adjacent`, "adjacent", TTL_MS);
  await queryCache.set("user-2:activity.stream", "other", TTL_MS);
  await queryCache.invalidate(key);
  await expect(queryCache.get(key)).resolves.toBeUndefined();
  await expect(queryCache.get(`${key}:adjacent`)).resolves.toBe("adjacent");
  await expect(queryCache.get("user-2:activity.stream")).resolves.toBe("other");
});

describe("Redis exact cache invalidation", () => {
  function createClient() {
    return {
      set: vi.fn(async () => "OK" as const),
      get: vi.fn(async () => null),
      del: vi.fn(async (..._keys: string[]) => 1),
      sadd: vi.fn(async () => 1),
      smembers: vi.fn(async () => []),
      srem: vi.fn(async (_key: string, ..._members: string[]) => 1),
    };
  }

  it("deletes only the exact payload and registration without prefix enumeration", async () => {
    const client = createClient();
    const store = new RedisCacheStore(async () => client);
    const key = 'user-1:activity.stream:UTC:{"activityId":"activity-1"}';

    await store.invalidate(key);

    expect(client.del).toHaveBeenCalledExactlyOnceWith(`query-cache:data:${key}`);
    expect(client.srem).toHaveBeenCalledExactlyOnceWith(
      "query-cache:keys",
      `query-cache:data:${key}`,
    );
    expect(client.smembers).not.toHaveBeenCalled();
  });

  it("propagates payload deletion failure without removing the registration", async () => {
    const client = createClient();
    const error = new Error("Redis DEL failed");
    client.del.mockRejectedValue(error);
    const store = new RedisCacheStore(async () => client);

    await expect(store.invalidate("user-1:activity.stream")).rejects.toBe(error);
    expect(client.srem).not.toHaveBeenCalled();
  });

  it("propagates registration removal failure after deleting the exact payload", async () => {
    const client = createClient();
    const error = new Error("Redis SREM failed");
    client.srem.mockRejectedValue(error);
    const store = new RedisCacheStore(async () => client);

    await expect(store.invalidate("user-1:activity.stream")).rejects.toBe(error);
    expect(client.del).toHaveBeenCalledExactlyOnceWith("query-cache:data:user-1:activity.stream");
  });
});

it("supports exact invalidation while caching is disabled", async () => {
  const store: CacheStore = new NullCacheStore();
  await store.set("user-1:activity.stream", "unused", TTL_MS);

  await expect(store.invalidate("user-1:activity.stream")).resolves.toBeUndefined();
  await expect(store.get("user-1:activity.stream")).resolves.toBeUndefined();
});
