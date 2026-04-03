import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// ── Shared Redis client type ──

interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
}

// ── OAuth 2.0 state ──

const oauthStateEntrySchema = z.object({
  providerId: z.string(),
  codeVerifier: z.string().optional(),
  intent: z.enum(["data", "login", "link"]),
  linkUserId: z.string().optional(),
  userId: z.string(),
  mobileScheme: z.string().optional(),
  returnTo: z.string().optional(),
});

export type OAuthStateEntry = z.infer<typeof oauthStateEntrySchema>;

export interface OAuthStateStore {
  save(state: string, entry: OAuthStateEntry, timeToLiveMs?: number): Promise<void>;
  get(state: string): Promise<OAuthStateEntry | null>;
  has(state: string): Promise<boolean>;
  delete(state: string): Promise<void>;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  #store = new Map<string, { entry: OAuthStateEntry; expiresAt: number }>();

  async save(state: string, entry: OAuthStateEntry, timeToLiveMs = DEFAULT_TTL_MS): Promise<void> {
    this.#store.set(state, { entry, expiresAt: Date.now() + timeToLiveMs });
  }

  async get(state: string): Promise<OAuthStateEntry | null> {
    const stored = this.#store.get(state);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.#store.delete(state);
      return null;
    }
    return stored.entry;
  }

  async has(state: string): Promise<boolean> {
    const entry = await this.get(state);
    return entry !== null;
  }

  async delete(state: string): Promise<void> {
    this.#store.delete(state);
  }
}

const OAUTH_STATE_KEY_PREFIX = "oauth-state:";

export class RedisOAuthStateStore implements OAuthStateStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async save(state: string, entry: OAuthStateEntry, timeToLiveMs = DEFAULT_TTL_MS): Promise<void> {
    const client = await this.#getRedisClient();
    await client.set(
      `${OAUTH_STATE_KEY_PREFIX}${state}`,
      JSON.stringify(entry),
      "PX",
      timeToLiveMs,
    );
  }

  async get(state: string): Promise<OAuthStateEntry | null> {
    const client = await this.#getRedisClient();
    const key = `${OAUTH_STATE_KEY_PREFIX}${state}`;
    const payload = await client.get(key);
    if (!payload) return null;

    try {
      const parsed = oauthStateEntrySchema.safeParse(JSON.parse(payload));
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

  async has(state: string): Promise<boolean> {
    const client = await this.#getRedisClient();
    const count = await client.exists(`${OAUTH_STATE_KEY_PREFIX}${state}`);
    return count > 0;
  }

  async delete(state: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.del(`${OAUTH_STATE_KEY_PREFIX}${state}`);
  }
}

// ── OAuth 1.0 secrets ──

const oauth1SecretEntrySchema = z.object({
  providerId: z.string(),
  tokenSecret: z.string(),
  userId: z.string(),
});

export type OAuth1SecretEntry = z.infer<typeof oauth1SecretEntrySchema>;

export interface OAuth1SecretStore {
  save(oauthToken: string, entry: OAuth1SecretEntry, timeToLiveMs?: number): Promise<void>;
  get(oauthToken: string): Promise<OAuth1SecretEntry | null>;
  delete(oauthToken: string): Promise<void>;
}

export class InMemoryOAuth1SecretStore implements OAuth1SecretStore {
  #store = new Map<string, { entry: OAuth1SecretEntry; expiresAt: number }>();

  async save(
    oauthToken: string,
    entry: OAuth1SecretEntry,
    timeToLiveMs = DEFAULT_TTL_MS,
  ): Promise<void> {
    this.#store.set(oauthToken, { entry, expiresAt: Date.now() + timeToLiveMs });
  }

  async get(oauthToken: string): Promise<OAuth1SecretEntry | null> {
    const stored = this.#store.get(oauthToken);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.#store.delete(oauthToken);
      return null;
    }
    return stored.entry;
  }

  async delete(oauthToken: string): Promise<void> {
    this.#store.delete(oauthToken);
  }
}

const OAUTH1_SECRET_KEY_PREFIX = "oauth1-secret:";

export class RedisOAuth1SecretStore implements OAuth1SecretStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async save(
    oauthToken: string,
    entry: OAuth1SecretEntry,
    timeToLiveMs = DEFAULT_TTL_MS,
  ): Promise<void> {
    const client = await this.#getRedisClient();
    await client.set(
      `${OAUTH1_SECRET_KEY_PREFIX}${oauthToken}`,
      JSON.stringify(entry),
      "PX",
      timeToLiveMs,
    );
  }

  async get(oauthToken: string): Promise<OAuth1SecretEntry | null> {
    const client = await this.#getRedisClient();
    const key = `${OAUTH1_SECRET_KEY_PREFIX}${oauthToken}`;
    const payload = await client.get(key);
    if (!payload) return null;

    try {
      const parsed = oauth1SecretEntrySchema.safeParse(JSON.parse(payload));
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

  async delete(oauthToken: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.del(`${OAUTH1_SECRET_KEY_PREFIX}${oauthToken}`);
  }
}

// ── Shared Redis connection ──

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
    exists: async (key) => redisClient.exists(key),
  };
}

// ── Factory functions ──

const defaultOAuthStateStore: OAuthStateStore =
  process.env.NODE_ENV === "test" ? new InMemoryOAuthStateStore() : new RedisOAuthStateStore();

const defaultOAuth1SecretStore: OAuth1SecretStore =
  process.env.NODE_ENV === "test" ? new InMemoryOAuth1SecretStore() : new RedisOAuth1SecretStore();

export function getOAuthStateStore(): OAuthStateStore {
  return defaultOAuthStateStore;
}

export function getOAuth1SecretStore(): OAuth1SecretStore {
  return defaultOAuth1SecretStore;
}
