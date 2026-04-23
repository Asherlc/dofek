import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";

const DEDUPE_KEY_PREFIX = "slack:dedupe:";

interface RedisDedupeClient {
  set(
    key: string,
    value: string,
    mode: "PX",
    millisecondsToExpire: number,
    condition: "NX",
  ): Promise<"OK" | null>;
}

export interface SlackDedupeStore {
  claim(key: string, ttlMilliseconds: number): Promise<boolean>;
}

export class InMemorySlackDedupeStore implements SlackDedupeStore {
  #expirationByKey = new Map<string, number>();

  async claim(key: string, ttlMilliseconds: number): Promise<boolean> {
    const fullKey = `${DEDUPE_KEY_PREFIX}${key}`;
    const now = Date.now();
    const existingExpiry = this.#expirationByKey.get(fullKey);
    if (typeof existingExpiry === "number" && existingExpiry > now) {
      return false;
    }
    this.#expirationByKey.set(fullKey, now + ttlMilliseconds);
    return true;
  }
}

export class RedisSlackDedupeStore implements SlackDedupeStore {
  readonly #getRedisClient: () => Promise<RedisDedupeClient>;

  constructor(getRedisClient: () => Promise<RedisDedupeClient> = getSharedRedisDedupeClient) {
    this.#getRedisClient = getRedisClient;
  }

  async claim(key: string, ttlMilliseconds: number): Promise<boolean> {
    const redisClient = await this.#getRedisClient();
    const result = await redisClient.set(
      `${DEDUPE_KEY_PREFIX}${key}`,
      "1",
      "PX",
      ttlMilliseconds,
      "NX",
    );
    return result === "OK";
  }
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisDedupeClient(): Promise<RedisDedupeClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const redisClient = await sharedRedisConnection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire, condition) =>
      redisClient.set(key, value, mode, millisecondsToExpire, condition),
  };
}

export function createSlackDedupeStore(): SlackDedupeStore {
  return process.env.NODE_ENV === "test"
    ? new InMemorySlackDedupeStore()
    : new RedisSlackDedupeStore();
}
