// cspell:ignore getdel

import { randomBytes } from "node:crypto";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";

const MOBILE_AUTH_CODE_TTL_MS = 60 * 1000;
const MOBILE_AUTH_CODE_PREFIX = "mobile-auth-exchange:";
const MOBILE_AUTH_GET_AND_DELETE_COMMAND = "dofekMobileAuthExchangeGetAndDelete";
const MOBILE_AUTH_GET_AND_DELETE_LUA = `
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
end
return value
`;

const mobileAuthExchangePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: z.string(), isNewUser: z.boolean() }),
  z.object({ kind: z.literal("provider"), userId: z.string(), providerId: z.string() }),
]);

export type MobileAuthExchangePayload = z.infer<typeof mobileAuthExchangePayloadSchema>;

interface RedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
}

interface RedisCommandClient {
  set(key: string, value: string, options: { PX: number }): Promise<string | null>;
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  runCommand(name: string, args: string[]): Promise<string | null>;
}

function isRedisCommandClient(value: unknown): value is RedisCommandClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    set?: unknown;
    defineCommand?: unknown;
    runCommand?: unknown;
  };
  return (
    typeof candidate.set === "function" &&
    typeof candidate.defineCommand === "function" &&
    typeof candidate.runCommand === "function"
  );
}

async function getSharedRedisClient(): Promise<RedisClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const redisClient = await sharedRedisConnection.client;
  if (!isRedisCommandClient(redisClient)) {
    throw new Error("Redis client does not support mobile auth exchange commands");
  }
  redisClient.defineCommand(MOBILE_AUTH_GET_AND_DELETE_COMMAND, {
    numberOfKeys: 1,
    lua: MOBILE_AUTH_GET_AND_DELETE_LUA,
  });
  return {
    set: async (key, value, options) => redisClient.set(key, value, options),
    getAndDelete: async (key) => redisClient.runCommand(MOBILE_AUTH_GET_AND_DELETE_COMMAND, [key]),
  };
}

let sharedRedisConnection: RedisConnection | null = null;

export interface MobileAuthExchangeStore {
  issue(payload: MobileAuthExchangePayload): Promise<string>;
  consume(code: string): Promise<MobileAuthExchangePayload | null>;
}

export class RedisMobileAuthExchangeStore implements MobileAuthExchangeStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async issue(payload: MobileAuthExchangePayload): Promise<string> {
    const code = randomBytes(32).toString("hex");
    const client = await this.#getRedisClient();
    await client.set(`${MOBILE_AUTH_CODE_PREFIX}${code}`, JSON.stringify(payload), {
      PX: MOBILE_AUTH_CODE_TTL_MS,
    });
    return code;
  }

  async consume(code: string): Promise<MobileAuthExchangePayload | null> {
    const client = await this.#getRedisClient();
    const rawPayload = await client.getAndDelete(`${MOBILE_AUTH_CODE_PREFIX}${code}`);
    if (!rawPayload) return null;
    try {
      const parsed = mobileAuthExchangePayloadSchema.safeParse(JSON.parse(rawPayload));
      return parsed.success ? parsed.data : null;
    } catch (error: unknown) {
      captureException(error, { tags: { context: "mobile-auth-exchange-parse" } });
      return null;
    }
  }
}

export class InMemoryMobileAuthExchangeStore implements MobileAuthExchangeStore {
  readonly #entries = new Map<string, { payload: MobileAuthExchangePayload; expiresAt: number }>();
  readonly #ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? MOBILE_AUTH_CODE_TTL_MS;
  }

  async issue(payload: MobileAuthExchangePayload): Promise<string> {
    const code = randomBytes(32).toString("hex");
    this.#entries.set(code, { payload, expiresAt: Date.now() + this.#ttlMs });
    return code;
  }

  async consume(code: string): Promise<MobileAuthExchangePayload | null> {
    const entry = this.#entries.get(code);
    this.#entries.delete(code);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }
}
