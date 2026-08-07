import { getSharedRedisConnection } from "dofek/jobs/queues";

interface RedisRegistryClient {
  mget(...keys: string[]): Promise<Array<string | null>>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
}

const CACHE_KEY_REGISTRY = "query-cache:keys";
const CACHE_KEY_PREFIX = "query-cache:data:";
const CACHE_KEY_BATCH_SIZE = 1000;

function supportsQueryCacheRegistry(client: object): client is RedisRegistryClient {
  return (
    "mget" in client &&
    typeof client.mget === "function" &&
    "smembers" in client &&
    typeof client.smembers === "function" &&
    "srem" in client &&
    typeof client.srem === "function"
  );
}

async function getSharedRedisClient(): Promise<RedisRegistryClient> {
  const connection = getSharedRedisConnection();
  const redisClient = await connection.client;
  if (!supportsQueryCacheRegistry(redisClient)) {
    throw new Error("Redis client does not support query-cache registry commands");
  }
  return redisClient;
}

function decodeRedisCacheKey(redisKey: string): string | null {
  return redisKey.startsWith(CACHE_KEY_PREFIX) ? redisKey.slice(CACHE_KEY_PREFIX.length) : null;
}

export class RedisQueryCacheRegistry {
  readonly #getRedisClient: () => Promise<RedisRegistryClient>;

  constructor(getRedisClient: () => Promise<RedisRegistryClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async listKeys(prefix = ""): Promise<string[]> {
    const client = await this.#getRedisClient();
    const registeredKeys = await client.smembers(CACHE_KEY_REGISTRY);
    const matchingKeys = registeredKeys.filter((registeredKey) =>
      decodeRedisCacheKey(registeredKey)?.startsWith(prefix),
    );
    const liveKeys: string[] = [];
    for (let batchStart = 0; batchStart < matchingKeys.length; batchStart += CACHE_KEY_BATCH_SIZE) {
      const keyBatch = matchingKeys.slice(batchStart, batchStart + CACHE_KEY_BATCH_SIZE);
      const payloads = await client.mget(...keyBatch);
      const expiredKeys: string[] = [];
      for (const [keyIndex, registeredKey] of keyBatch.entries()) {
        if (payloads[keyIndex] === null) {
          expiredKeys.push(registeredKey);
          continue;
        }
        liveKeys.push(registeredKey.slice(CACHE_KEY_PREFIX.length));
      }
      if (expiredKeys.length > 0) {
        await client.srem(CACHE_KEY_REGISTRY, ...expiredKeys);
      }
    }
    return liveKeys;
  }
}
