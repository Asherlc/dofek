import { createHash } from "node:crypto";
import {
  ProviderRateLimitError,
  type ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { providerAdaptiveRateLimitStore } from "../lib/provider-adaptive-rate-limit.ts";
import {
  compareAndSetRedisValue,
  type RedisCompareAndSetClient,
} from "../lib/redis-compare-and-set.ts";
import { getSharedRedisConnection, type SyncJobData } from "./queues.ts";

export type ProviderRateLimitCooldownScope = "provider" | "user";
type ProviderDeferralError = ProviderRateLimitError | ProviderServiceUnavailableError;

export interface ProviderRateLimitCooldown {
  providerId: string;
  scope: ProviderRateLimitCooldownScope;
  userId: string | null;
  expiresAt: Date;
  /** Absent on rate-limit records, including records written by previous workers. */
  reason?: "service_unavailable";
  /** Number of consecutive rate-limit hits; used to escalate cooldown duration. */
  consecutiveHits?: number;
}

export interface ProviderRateLimitCooldownStore {
  record(error: ProviderDeferralError, fallbackUserId: string): Promise<ProviderRateLimitCooldown>;
  getActive(providerId: string, userId: string): Promise<ProviderRateLimitCooldown | null>;
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
    ["whoop", 60 * 60],
  ]);
  return providerFallbackCooldownSeconds.get(providerId) ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS;
}

function maxCooldownSeconds(providerId: string): number {
  const providerMaxCooldownSeconds = new Map<string, number>([["whoop", 4 * 60 * 60]]);
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
    reason: cooldown.reason,
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
  const reason = Reflect.get(parsed, "reason");
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
    ...(reason === "service_unavailable" ? { reason } : {}),
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
  error: ProviderDeferralError,
  fallbackUserId: string,
  previous: ProviderRateLimitCooldown | null,
  baseFallbackSeconds: number,
): ProviderRateLimitCooldown {
  const scope = error.scope;
  const userId = scope === "user" ? (error.userId ?? fallbackUserId) : null;
  if (!(error instanceof ProviderRateLimitError)) {
    if (!error.retryAfterSeconds || error.retryAfterSeconds <= 0) {
      throw new Error("A service outage cooldown requires a positive Retry-After delay");
    }
    return {
      providerId: error.providerId,
      scope,
      userId,
      expiresAt: new Date(Date.now() + error.retryAfterSeconds * 1000),
      reason: "service_unavailable",
    };
  }
  const consecutiveHits = consecutiveHitsForRecord(
    previous?.reason === undefined ? previous : null,
  );
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
  error: ProviderDeferralError,
  fallbackUserId: string,
  previous: ProviderRateLimitCooldown | null,
  baseFallbackSeconds: number,
): ProviderRateLimitCooldown {
  const next = cooldownFromError(error, fallbackUserId, previous, baseFallbackSeconds);
  const activePrevious = activeOrNull(previous);
  if (activePrevious && activePrevious.expiresAt > next.expiresAt) {
    if (activePrevious.reason !== next.reason) return activePrevious;
    return {
      ...activePrevious,
      consecutiveHits: next.consecutiveHits,
    };
  }
  return next;
}

async function persistCooldownAtomically(
  redisClient: RedisCompareAndSetClient,
  key: string,
  computeEffective: (previous: ProviderRateLimitCooldown | null) => ProviderRateLimitCooldown,
): Promise<ProviderRateLimitCooldown> {
  for (let retries = 0; retries < MAX_COOLDOWN_RETRIES; retries++) {
    const raw = await redisClient.get(key);
    const previous = parseProviderRateLimitCooldown(raw);
    const effective = computeEffective(previous);
    const saved = await compareAndSetRedisValue(
      redisClient,
      key,
      raw,
      serializeCooldown(effective),
      providerRateLimitDelayMs(effective),
    );
    if (saved) return effective;
  }
  throw new Error(
    `Failed to persist rate-limit cooldown for ${key} after ${MAX_COOLDOWN_RETRIES} Redis transaction conflicts`,
  );
}

export class InMemoryProviderRateLimitCooldownStore implements ProviderRateLimitCooldownStore {
  readonly #cooldownRecords = new Map<string, ProviderRateLimitCooldown>();

  async record(
    error: ProviderDeferralError,
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

function getSharedRedisClient(): Promise<RedisCompareAndSetClient> {
  return getSharedRedisConnection().client;
}

export class RedisProviderRateLimitCooldownStore implements ProviderRateLimitCooldownStore {
  readonly #getRedisClient: () => Promise<RedisCompareAndSetClient>;

  constructor(getRedisClient: () => Promise<RedisCompareAndSetClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async record(
    error: ProviderDeferralError,
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

export function providerCooldownLabel(cooldown: Pick<ProviderRateLimitCooldown, "reason">): string {
  return cooldown.reason === "service_unavailable" ? "Service unavailable" : "Rate limited";
}

export function providerSyncDeferralMessage(
  cooldown: Pick<ProviderRateLimitCooldown, "expiresAt" | "reason"> | null,
): string {
  return cooldown
    ? `${providerCooldownLabel(cooldown)}; sync deferred until ${cooldown.expiresAt.toISOString()}`
    : "Sync was deferred. Try syncing again.";
}

export function providerRateLimitDelayMs(
  cooldown: ProviderRateLimitCooldown,
  now = new Date(),
): number {
  return Math.max(0, cooldown.expiresAt.getTime() - now.getTime());
}

export function providerRateLimitCooldownJobId(
  cooldown: ProviderRateLimitCooldown,
  jobData: SyncJobData,
): string {
  const safeProviderId = (jobData.providerId ?? cooldown.providerId).replace(/:/g, "-");
  const digest = createHash("sha256").update(JSON.stringify(jobData)).digest("hex").slice(0, 24);
  return `${KEY_PREFIX}-${safeProviderId}-${cooldown.scope}-${cooldown.expiresAt.getTime()}-${digest}`;
}
