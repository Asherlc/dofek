import { getSharedRedisConnection } from "dofek/jobs/queues";
import { captureException } from "./error-reporting.ts";

export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set<T>(key: string, data: T, ttlMs: number): Promise<void>;
  invalidateByPrefix(prefix: string): Promise<void>;
  invalidateAll(): Promise<void>;
}

interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
}

const CACHE_KEY_REGISTRY = "query-cache:keys";
const CACHE_KEY_PREFIX = "query-cache:data:";

function redisCacheKey(key: string): string {
  return `${CACHE_KEY_PREFIX}${key}`;
}

function decodeRedisCacheKey(redisKey: string): string | null {
  return redisKey.startsWith(CACHE_KEY_PREFIX) ? redisKey.slice(CACHE_KEY_PREFIX.length) : null;
}

export class MemoryCacheStore implements CacheStore {
  #store = new Map<string, { data: unknown; expiresAt: number }>();
  #sweepInterval: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs = 5 * 60 * 1000) {
    this.#sweepInterval = setInterval(() => this.#sweep(), sweepIntervalMs);
    // Don't keep process alive just for cache cleanup
    if (typeof this.#sweepInterval !== "number") {
      this.#sweepInterval.unref();
    }
  }

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    this.#store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    for (const key of this.#store.keys()) {
      if (key.startsWith(prefix)) this.#store.delete(key);
    }
  }

  async invalidateAll(): Promise<void> {
    this.#store.clear();
  }

  #sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (entry.expiresAt <= now) this.#store.delete(key);
    }
  }
}

export class RedisCacheStore implements CacheStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async get(key: string): Promise<unknown | undefined> {
    const client = await this.#getRedisClient();
    const cacheKey = redisCacheKey(key);
    const payload = await client.get(cacheKey);
    if (payload === null) {
      await client.srem(CACHE_KEY_REGISTRY, cacheKey);
      return undefined;
    }
    try {
      return JSON.parse(payload);
    } catch (error) {
      captureException(error, { tags: { cacheStore: "redis", cacheOperation: "get" } });
      try {
        await client.del(cacheKey);
        await client.srem(CACHE_KEY_REGISTRY, cacheKey);
      } catch (cleanupError) {
        captureException(cleanupError, {
          tags: { cacheStore: "redis", cacheOperation: "evictInvalidPayload" },
        });
      }
      return undefined;
    }
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    const client = await this.#getRedisClient();
    const cacheKey = redisCacheKey(key);
    await client.set(cacheKey, JSON.stringify(data), "PX", ttlMs);
    await client.sadd(CACHE_KEY_REGISTRY, cacheKey);
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    const client = await this.#getRedisClient();
    const cacheKeys = await client.smembers(CACHE_KEY_REGISTRY);
    const matchingKeys = cacheKeys.filter((cacheKey) => {
      const decoded = decodeRedisCacheKey(cacheKey);
      return decoded?.startsWith(prefix);
    });
    if (matchingKeys.length === 0) return;
    await client.del(...matchingKeys);
    await client.srem(CACHE_KEY_REGISTRY, ...matchingKeys);
  }

  async invalidateAll(): Promise<void> {
    const client = await this.#getRedisClient();
    const cacheKeys = await client.smembers(CACHE_KEY_REGISTRY);
    if (cacheKeys.length > 0) {
      await client.del(...cacheKeys);
      await client.srem(CACHE_KEY_REGISTRY, ...cacheKeys);
    }
  }
}

/** No-op cache store — always misses. Used in e2e test environments where
 *  Cypress inserts data directly into the DB and expects immediate visibility. */
export class NullCacheStore implements CacheStore {
  async get(): Promise<undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async invalidateByPrefix(): Promise<void> {}
  async invalidateAll(): Promise<void> {}
}

async function getSharedRedisClient(): Promise<RedisClient> {
  const connection = getSharedRedisConnection();
  const redisClient = await connection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire) =>
      redisClient.set(key, value, mode, millisecondsToExpire),
    get: async (key) => redisClient.get(key),
    del: async (...keys) => redisClient.del(...keys),
    sadd: async (key, ...members) => redisClient.sadd(key, ...members),
    smembers: async (key) => redisClient.smembers(key),
    srem: async (key, ...members) => redisClient.srem(key, ...members),
  };
}

export const queryCache: CacheStore =
  process.env.DISABLE_QUERY_CACHE === "true"
    ? new NullCacheStore()
    : process.env.NODE_ENV === "test"
      ? new MemoryCacheStore()
      : new RedisCacheStore();

const USER_QUERY_PREFIXES = {
  activity: ["activity.", "calendar."],
  journalEntries: ["journal.entries", "journal.trends", "behaviorImpact."],
  lifeEvents: ["lifeEvents."],
  menstrualCycle: ["menstrualCycle."],
  personalExperiments: ["personalExperiments."],
  personalization: ["personalization.", "mobileDashboard.", "recovery.", "stress.", "pmc."],
  sportSettings: ["sportSettings."],
  subjective: ["subjective."],
} as const;

export type UserQueryCacheDomain = keyof typeof USER_QUERY_PREFIXES;

/**
 * Invalidates every cached read model derived from the supplied user domains.
 * Keep the dependency map here so router, job, and REST write paths agree.
 */
export async function invalidateUserQueryDomains(
  userId: string,
  domains: readonly UserQueryCacheDomain[],
): Promise<void> {
  const prefixes = new Set(domains.flatMap((domain) => USER_QUERY_PREFIXES[domain]));
  await Promise.all(
    [...prefixes].map((prefix) => queryCache.invalidateByPrefix(`${userId}:${prefix}`)),
  );
}

/** Invalidates every cached query for a user after a cross-domain write. */
export async function invalidateAllUserQueries(userId: string): Promise<void> {
  await queryCache.invalidateByPrefix(`${userId}:`);
}

/** Invalidates the shared query cache after a write to globally visible data. */
export async function invalidateAllQueries(): Promise<void> {
  await queryCache.invalidateAll();
}
