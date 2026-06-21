import type { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { RedisConnection } from "bullmq";
import { providerAdaptiveRateLimitStore } from "../lib/provider-adaptive-rate-limit.ts";
import { getRedisConnection } from "./queues.ts";

export type ProviderRateLimitCooldownScope = "provider" | "user";

export interface ProviderRateLimitCooldown {
  providerId: string;
  scope: ProviderRateLimitCooldownScope;
  userId: string | null;
  expiresAt: Date;
  /** Number of consecutive rate-limit hits; used to escalate cooldown duration. */
  consecutiveHits?: number;
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
  ["garmin", 60 * 60],
  ["whoop", 60 * 60],
]);

const PROVIDER_MAX_COOLDOWN_SECONDS = new Map<string, number>([
  ["garmin", 4 * 60 * 60],
  ["whoop", 4 * 60 * 60],
]);

const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 30 * 60;
const DEFAULT_MAX_COOLDOWN_SECONDS = 2 * 60 * 60;
const STRIKE_RESET_AFTER_MS = 2 * 60 * 60 * 1000;
const KEY_PREFIX = "provider-rate-limit";

function fallbackCooldownSeconds(providerId: string): number {
  return PROVIDER_FALLBACK_COOLDOWN_SECONDS.get(providerId) ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS;
}

function maxCooldownSeconds(providerId: string): number {
  return PROVIDER_MAX_COOLDOWN_SECONDS.get(providerId) ?? DEFAULT_MAX_COOLDOWN_SECONDS;
}

function consecutiveHitsForRecord(
  previous: ProviderRateLimitCooldown | null,
  now = new Date(),
): number {
  if (!previous) return 1;
  const msSinceExpiry = now.getTime() - previous.expiresAt.getTime();
  if (msSinceExpiry > STRIKE_RESET_AFTER_MS) return 1;
  return (previous.consecutiveHits ?? 1) + 1;
}

function escalatedCooldownSeconds(
  providerId: string,
  baseSeconds: number,
  consecutiveHits: number,
): number {
  if (consecutiveHits <= 1) return baseSeconds;
  const maxSeconds = maxCooldownSeconds(providerId);
  const escalated = baseSeconds * 2 ** (consecutiveHits - 1);
  return Math.min(escalated, maxSeconds);
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
    consecutiveHits: cooldown.consecutiveHits,
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
  const consecutiveHits = Reflect.get(parsed, "consecutiveHits");
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
    consecutiveHits:
      typeof consecutiveHits === "number" && Number.isFinite(consecutiveHits)
        ? consecutiveHits
        : undefined,
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
  previous: ProviderRateLimitCooldown | null,
  baseFallbackSeconds: number,
): ProviderRateLimitCooldown {
  const scope = error.scope;
  const userId = scope === "user" ? (error.userId ?? fallbackUserId) : null;
  const consecutiveHits = consecutiveHitsForRecord(previous);
  const durationSeconds =
    error.retryAfterSeconds && error.retryAfterSeconds > 0
      ? error.retryAfterSeconds
      : escalatedCooldownSeconds(error.providerId, baseFallbackSeconds, consecutiveHits);
  const expiresAt = new Date(Date.now() + durationSeconds * 1000);
  return {
    providerId: error.providerId,
    scope,
    userId,
    expiresAt,
    consecutiveHits,
  };
}

function effectiveCooldown(
  error: ProviderRateLimitError,
  fallbackUserId: string,
  previous: ProviderRateLimitCooldown | null,
  baseFallbackSeconds: number,
): ProviderRateLimitCooldown {
  const next = cooldownFromError(error, fallbackUserId, previous, baseFallbackSeconds);
  const activePrevious = activeOrNull(previous);
  if (activePrevious && activePrevious.expiresAt > next.expiresAt) {
    return {
      ...activePrevious,
      consecutiveHits: next.consecutiveHits,
    };
  }
  return next;
}

export class InMemoryProviderRateLimitCooldownStore implements ProviderRateLimitCooldownStore {
  readonly #cooldownRecords = new Map<string, ProviderRateLimitCooldown>();

  async record(
    error: ProviderRateLimitError,
    fallbackUserId: string,
  ): Promise<ProviderRateLimitCooldown> {
    const learned = await providerAdaptiveRateLimitStore.getLearnedCooldownSeconds(
      error.providerId,
    );
    const baseFallback = learned ?? fallbackCooldownSeconds(error.providerId);
    const cooldown = cooldownFromError(error, fallbackUserId, null, baseFallback);
    const key = cooldownKey(cooldown.providerId, cooldown.scope, cooldown.userId);
    const existing = this.#cooldownRecords.get(key) ?? null;
    const effective = effectiveCooldown(error, fallbackUserId, existing, baseFallback);
    this.#cooldownRecords.set(key, effective);
    return effective;
  }

  async getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null> {
    const providerCooldown = activeOrNull(
      this.#cooldownRecords.get(cooldownKey(providerId, "provider", null)) ?? null,
    );
    const userCooldown = activeOrNull(
      this.#cooldownRecords.get(cooldownKey(providerId, "user", userId)) ?? null,
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
    const learned = await providerAdaptiveRateLimitStore.getLearnedCooldownSeconds(
      error.providerId,
    );
    const baseFallback = learned ?? fallbackCooldownSeconds(error.providerId);
    const cooldown = cooldownFromError(error, fallbackUserId, null, baseFallback);
    const key = cooldownKey(cooldown.providerId, cooldown.scope, cooldown.userId);
    const redisClient = await this.#getRedisClient();
    const previous = parseCooldown(await redisClient.get(key));
    const effective = effectiveCooldown(error, fallbackUserId, previous, baseFallback);
    const millisecondsToExpire = providerRateLimitDelayMs(effective);
    await redisClient.set(key, serializeCooldown(effective), "PX", millisecondsToExpire);
    return effective;
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
  process.env.NODE_ENV === "test" || process.env.VITEST === "true"
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
  return `${KEY_PREFIX}-${cooldown.providerId}-${cooldown.scope}-${cooldown.userId ?? jobUserId}-${cooldown.expiresAt.getTime()}`;
}
