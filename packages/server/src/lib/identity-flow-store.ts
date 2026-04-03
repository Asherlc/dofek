import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

const KEY_PREFIX = "identity-flow:";
export const DEFAULT_IDENTITY_FLOW_TTL_MS = 10 * 60 * 1000;

const identityFlowEntrySchema = z.object({
  codeVerifier: z.string(),
  linkUserId: z.string().optional(),
  mobileScheme: z.string().optional(),
  returnTo: z.string().optional(),
});

export type IdentityFlowEntry = z.infer<typeof identityFlowEntrySchema>;

interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface IdentityFlowStore {
  save(state: string, entry: IdentityFlowEntry, timeToLiveMs?: number): Promise<void>;
  get(state: string): Promise<IdentityFlowEntry | null>;
  delete(state: string): Promise<void>;
}

export class InMemoryIdentityFlowStore implements IdentityFlowStore {
  #store = new Map<string, { entry: IdentityFlowEntry; expiresAt: number }>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();

  async save(
    state: string,
    entry: IdentityFlowEntry,
    timeToLiveMs = DEFAULT_IDENTITY_FLOW_TTL_MS,
  ): Promise<void> {
    const existing = this.#timers.get(state);
    if (existing) clearTimeout(existing);
    this.#store.set(state, { entry, expiresAt: Date.now() + timeToLiveMs });
    this.#timers.set(
      state,
      setTimeout(() => {
        this.#store.delete(state);
        this.#timers.delete(state);
      }, timeToLiveMs),
    );
  }

  async get(state: string): Promise<IdentityFlowEntry | null> {
    const stored = this.#store.get(state);
    if (!stored) return null;

    if (stored.expiresAt <= Date.now()) {
      this.#store.delete(state);
      return null;
    }

    return stored.entry;
  }

  async delete(state: string): Promise<void> {
    this.#store.delete(state);
    const timer = this.#timers.get(state);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(state);
    }
  }
}

export class RedisIdentityFlowStore implements IdentityFlowStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async save(
    state: string,
    entry: IdentityFlowEntry,
    timeToLiveMs = DEFAULT_IDENTITY_FLOW_TTL_MS,
  ): Promise<void> {
    const client = await this.#getRedisClient();
    await client.set(getRedisKey(state), JSON.stringify(entry), "PX", timeToLiveMs);
  }

  async get(state: string): Promise<IdentityFlowEntry | null> {
    const client = await this.#getRedisClient();
    const key = getRedisKey(state);
    const payload = await client.get(key);
    if (!payload) return null;

    try {
      const parsed = identityFlowEntrySchema.safeParse(JSON.parse(payload));
      if (!parsed.success) {
        await client.del(key);
        return null;
      }
      return parsed.data;
    } catch {
      await client.del(key);
      return null;
    }
  }

  async delete(state: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.del(getRedisKey(state));
  }
}

function getRedisKey(state: string): string {
  return `${KEY_PREFIX}${state}`;
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisClient(): Promise<RedisClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const redisClient = await sharedRedisConnection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire) =>
      redisClient.set(key, value, mode, millisecondsToExpire),
    get: async (key) => redisClient.get(key),
    del: async (key) => redisClient.del(key),
  };
}

const defaultStore: IdentityFlowStore =
  process.env.NODE_ENV === "test" ? new InMemoryIdentityFlowStore() : new RedisIdentityFlowStore();

export function getIdentityFlowStore(): IdentityFlowStore {
  return defaultStore;
}
