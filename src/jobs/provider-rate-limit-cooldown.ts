import type { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "./queues.ts";

export type ProviderRateLimitCooldownScope = "provider" | "user";

export interface ProviderRateLimitCooldown {
  providerId: string;
  scope: ProviderRateLimitCooldownScope;
  userId: string | null;
  expiresAt: Date;
}

export interface ProviderRateLimitCooldownStore {
  record(error: ProviderRateLimitError, fallbackUserId: string): Promise<ProviderRateLimitCooldown>;
  getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null>;
}

interface RedisClient {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
}

const PROVIDER_FALLBACK_COOLDOWN_SECONDS = new Map<string, number>([
  ["strava", 15 * 60],
  ["withings", 60],
  ["fitbit", 60 * 60],
  ["garmin", 30 * 60],
]);

const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 30 * 60;
const KEY_PREFIX = "provider-rate-limit";

function fallbackCooldownSeconds(providerId: string): number {
  return PROVIDER_FALLBACK_COOLDOWN_SECONDS.get(providerId) ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS;
}

function cooldownDurationSeconds(error: ProviderRateLimitError): number {
  return error.retryAfterSeconds && error.retryAfterSeconds > 0
    ? error.retryAfterSeconds
    : fallbackCooldownSeconds(error.providerId);
}

function cooldownKey(
  providerId: string,
  scope: ProviderRateLimitCooldownScope,
  userId: string | null,
): string {
  return scope === "provider"
    ? `${KEY_PREFIX}:${providerId}:provider`
    : `${KEY_PREFIX}:${providerId}:user:${userId ?? "unknown"}`;
}

function serializeCooldown(cooldown: ProviderRateLimitCooldown): string {
  return JSON.stringify({
    providerId: cooldown.providerId,
    scope: cooldown.scope,
    userId: cooldown.userId,
    expiresAt: cooldown.expiresAt.toISOString(),
  });
}

function parseCooldown(raw: string | null): ProviderRateLimitCooldown | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const providerId = Reflect.get(parsed, "providerId");
  const scope = Reflect.get(parsed, "scope");
  const userId = Reflect.get(parsed, "userId");
  const expiresAtValue = Reflect.get(parsed, "expiresAt");
  if (typeof providerId !== "string") return null;
  if (scope !== "provider" && scope !== "user") return null;
  if (userId !== null && typeof userId !== "string") return null;
  if (typeof expiresAtValue !== "string") return null;
  const expiresAt = new Date(expiresAtValue);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return {
    providerId,
    scope,
    userId,
    expiresAt,
  };
}

function laterCooldown(
  first: ProviderRateLimitCooldown | null,
  second: ProviderRateLimitCooldown | null,
): ProviderRateLimitCooldown | null {
  if (!first) return second;
  if (!second) return first;
  return first.expiresAt >= second.expiresAt ? first : second;
}

function activeOrNull(
  cooldown: ProviderRateLimitCooldown | null,
  now = new Date(),
): ProviderRateLimitCooldown | null {
  if (!cooldown) return null;
  return cooldown.expiresAt > now ? cooldown : null;
}

function cooldownFromError(
  error: ProviderRateLimitError,
  fallbackUserId: string,
): ProviderRateLimitCooldown {
  const scope = error.scope;
  const userId = scope === "user" ? (error.userId ?? fallbackUserId) : null;
  const expiresAt = new Date(Date.now() + cooldownDurationSeconds(error) * 1000);
  return { providerId: error.providerId, scope, userId, expiresAt };
}

export class InMemoryProviderRateLimitCooldownStore implements ProviderRateLimitCooldownStore {
  readonly #cooldowns = new Map<string, ProviderRateLimitCooldown>();

  async record(
    error: ProviderRateLimitError,
    fallbackUserId: string,
  ): Promise<ProviderRateLimitCooldown> {
    const cooldown = cooldownFromError(error, fallbackUserId);
    this.#cooldowns.set(
      cooldownKey(cooldown.providerId, cooldown.scope, cooldown.userId),
      cooldown,
    );
    return cooldown;
  }

  async getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null> {
    const providerCooldown = activeOrNull(
      this.#cooldowns.get(cooldownKey(providerId, "provider", null)) ?? null,
    );
    const userCooldown = activeOrNull(
      this.#cooldowns.get(cooldownKey(providerId, "user", userId)) ?? null,
    );
    return laterCooldown(providerCooldown, userCooldown);
  }
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
  };
}

export class RedisProviderRateLimitCooldownStore implements ProviderRateLimitCooldownStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async record(
    error: ProviderRateLimitError,
    fallbackUserId: string,
  ): Promise<ProviderRateLimitCooldown> {
    const cooldown = cooldownFromError(error, fallbackUserId);
    const millisecondsToExpire = providerRateLimitDelayMs(cooldown);
    const redisClient = await this.#getRedisClient();
    await redisClient.set(
      cooldownKey(cooldown.providerId, cooldown.scope, cooldown.userId),
      serializeCooldown(cooldown),
      "PX",
      millisecondsToExpire,
    );
    return cooldown;
  }

  async getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null> {
    const redisClient = await this.#getRedisClient();
    const [providerRaw, userRaw] = await Promise.all([
      redisClient.get(cooldownKey(providerId, "provider", null)),
      redisClient.get(cooldownKey(providerId, "user", userId)),
    ]);
    const providerCooldown = activeOrNull(parseCooldown(providerRaw));
    const userCooldown = activeOrNull(parseCooldown(userRaw));
    return laterCooldown(providerCooldown, userCooldown);
  }
}

export const providerRateLimitCooldownStore: ProviderRateLimitCooldownStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryProviderRateLimitCooldownStore()
    : new RedisProviderRateLimitCooldownStore();

export function providerRateLimitDelayMs(
  cooldown: ProviderRateLimitCooldown,
  now = new Date(),
): number {
  return Math.max(0, cooldown.expiresAt.getTime() - now.getTime());
}

export function providerRateLimitCooldownJobId(
  cooldown: ProviderRateLimitCooldown,
  jobUserId: string,
): string {
  return `${KEY_PREFIX}:${cooldown.providerId}:${cooldown.scope}:${cooldown.userId ?? jobUserId}:${cooldown.expiresAt.getTime()}`;
}
