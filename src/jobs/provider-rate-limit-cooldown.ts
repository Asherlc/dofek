import type { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { providerAdaptiveRateLimitStore } from "../lib/provider-adaptive-rate-limit.ts";
import { getSharedRedisConnection } from "./queues.ts";

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

interface RedisMulti {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => RedisMulti;
  exec: () => Promise<unknown[] | null>;
}

interface RedisClient {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  watch?: (key: string) => Promise<unknown>;
  multi?: () => RedisMulti;
}

const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 30 * 60;
const DEFAULT_MAX_COOLDOWN_SECONDS = 2 * 60 * 60;
const STRIKE_RESET_AFTER_MS = 2 * 60 * 60 * 1000;
const MAX_COOLDOWN_RETRIES = 10;
const KEY_PREFIX = "provider-rate-limit";

function fallbackCooldownSeconds(providerId: string): number {
  const providerFallbackCooldownSeconds = new Map<string, number>([
    ["strava", 15 * 60],
    ["withings", 60],
    ["fitbit", 60 * 60],
    // Garmin omits Retry-After; use a cooldown longer than the 30-minute scheduled sync
    // interval so delayed retries are not immediately followed by a fresh scheduled fan-out.
    ["garmin", 2 * 60 * 60],
    ["whoop", 60 * 60],
  ]);
  return providerFallbackCooldownSeconds.get(providerId) ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS;
}

function maxCooldownSeconds(providerId: string): number {
  const providerMaxCooldownSeconds = new Map<string, number>([
    ["garmin", 4 * 60 * 60],
    ["whoop", 4 * 60 * 60],
  ]);
  return providerMaxCooldownSeconds.get(providerId) ?? DEFAULT_MAX_COOLDOWN_SECONDS;
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

export function parseProviderRateLimitCooldown(
  raw: string | null,
): ProviderRateLimitCooldown | null {
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

async function persistCooldownAtomically(
  redisClient: RedisClient,
  key: string,
  computeEffective: (previous: ProviderRateLimitCooldown | null) => ProviderRateLimitCooldown,
): Promise<ProviderRateLimitCooldown> {
  const watch = redisClient.watch;
  const multi = redisClient.multi;
  if (!watch || !multi) {
    const previous = parseProviderRateLimitCooldown(await redisClient.get(key));
    const effective = computeEffective(previous);
    await redisClient.set(
      key,
      serializeCooldown(effective),
      "PX",
      providerRateLimitDelayMs(effective),
    );
    return effective;
  }

  let retries = 0;
  for (;;) {
    await watch(key);
    const previous = parseProviderRateLimitCooldown(await redisClient.get(key));
    const effective = computeEffective(previous);
    const execResult = await multi()
      .set(key, serializeCooldown(effective), "PX", providerRateLimitDelayMs(effective))
      .exec();
    if (execResult) return effective;
    retries++;
    if (retries >= MAX_COOLDOWN_RETRIES) {
      throw new Error(
        `Failed to persist rate-limit cooldown for ${key} after ${MAX_COOLDOWN_RETRIES} Redis transaction conflicts`,
      );
    }
  }
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

async function getSharedRedisClient(): Promise<RedisClient> {
  const connection = getSharedRedisConnection();
  const redisClient = await connection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire) =>
      redisClient.set(key, value, mode, millisecondsToExpire),
    get: async (key) => redisClient.get(key),
    watch: async (key) => redisClient.watch(key),
    multi: () => {
      const transaction = redisClient.multi();
      const chain: RedisMulti = {
        set: (key, value, mode, millisecondsToExpire) => {
          transaction.set(key, value, mode, millisecondsToExpire);
          return chain;
        },
        exec: async () => transaction.exec(),
      };
      return chain;
    },
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
    return persistCooldownAtomically(redisClient, key, (previous) =>
      effectiveCooldown(error, fallbackUserId, previous, baseFallback),
    );
  }

  async getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null> {
    const redisClient = await this.#getRedisClient();
    const [providerRaw, userRaw] = await Promise.all([
      redisClient.get(cooldownKey(providerId, "provider", null)),
      redisClient.get(cooldownKey(providerId, "user", userId)),
    ]);
    const providerCooldown = activeOrNull(parseProviderRateLimitCooldown(providerRaw));
    const userCooldown = activeOrNull(parseProviderRateLimitCooldown(userRaw));
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
  const safeProviderId = cooldown.providerId.replace(/:/g, "-");
  const safeUserId = (cooldown.userId ?? jobUserId).replace(/:/g, "-");
  const suffix = cooldown.scope === "provider" ? "" : `-${safeUserId}`;
  return `${KEY_PREFIX}-${safeProviderId}-${cooldown.scope}${suffix}-${cooldown.expiresAt.getTime()}`;
}
