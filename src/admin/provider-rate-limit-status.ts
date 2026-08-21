import {
  ADAPTIVE_RATE_STORAGE_KEY_PREFIX,
  defaultInferredBudget,
  defaultThrottleMs,
  type ProviderAdaptiveRateState,
  parseAdaptiveRateState,
  slideAdaptiveWindow,
} from "@dofek/provider-http/adaptive-rate-limit";
import { getConfiguredProviderIds, getProviderQueueConfig } from "../jobs/provider-queue-config.ts";
import {
  type ProviderRateLimitCooldown,
  parseProviderRateLimitCooldown,
} from "../jobs/provider-rate-limit-cooldown.ts";
import { getSharedRedisConnection } from "../jobs/queues.ts";

const COOLDOWN_KEY_PREFIX = "provider-rate-limit";

export interface ProviderRateLimitStatusRow {
  providerId: string;
  scope: "provider" | "user";
  userId: string | null;
  syncTier: string;
  concurrency: number;
  queueLimiterMax: number | null;
  queueLimiterDurationMs: number | null;
  defaultThrottleMs: number;
  throttleMs: number | null;
  inferredBudget: number | null;
  observedCooldownSeconds: number | null;
  requestCount: number | null;
  windowStartMs: number | null;
  stravaShortUsage: number | null;
  stravaShortLimit: number | null;
  stravaDailyUsage: number | null;
  stravaDailyLimit: number | null;
  cooldownExpiresAt: string | null;
  consecutiveHits: number | null;
  hasLiveState: boolean;
}

interface ScopedRedisKey {
  providerId: string;
  scope: "provider" | "user";
  userId: string | null;
}

interface RedisReader {
  get: (key: string) => Promise<string | null>;
  scan: (
    cursor: string,
    matchKeyword: "MATCH",
    pattern: string,
    countKeyword: "COUNT",
    count: string,
  ) => Promise<[string, string[]]>;
}

function rowKey(providerId: string, scope: "provider" | "user", userId: string | null): string {
  return `${providerId}:${scope}:${userId ?? ""}`;
}

function buildBaseRow(
  providerId: string,
  scope: "provider" | "user",
  userId: string | null,
): ProviderRateLimitStatusRow {
  const config = getProviderQueueConfig(providerId);
  return {
    providerId,
    scope,
    userId,
    syncTier: config.syncTier,
    concurrency: config.concurrency,
    queueLimiterMax: config.limiter?.max ?? null,
    queueLimiterDurationMs: config.limiter?.duration ?? null,
    defaultThrottleMs: defaultThrottleMs(providerId),
    throttleMs: null,
    inferredBudget: null,
    observedCooldownSeconds: null,
    requestCount: null,
    windowStartMs: null,
    stravaShortUsage: null,
    stravaShortLimit: null,
    stravaDailyUsage: null,
    stravaDailyLimit: null,
    cooldownExpiresAt: null,
    consecutiveHits: null,
    hasLiveState: false,
  };
}

function applyAdaptiveState(
  row: ProviderRateLimitStatusRow,
  state: ProviderAdaptiveRateState,
  nowMs: number,
): ProviderRateLimitStatusRow {
  const slid = slideAdaptiveWindow(state, nowMs);
  return {
    ...row,
    throttleMs: slid.throttleMs,
    inferredBudget: slid.inferredBudget,
    observedCooldownSeconds: slid.observedCooldownSeconds,
    requestCount: slid.requestCount,
    windowStartMs: slid.windowStartMs,
    stravaShortUsage: slid.stravaShortUsage,
    stravaShortLimit: slid.stravaShortLimit,
    stravaDailyUsage: slid.stravaDailyUsage,
    stravaDailyLimit: slid.stravaDailyLimit,
    hasLiveState: true,
  };
}

function applyCooldown(
  row: ProviderRateLimitStatusRow,
  cooldown: ProviderRateLimitCooldown,
  now: Date,
): ProviderRateLimitStatusRow {
  if (cooldown.expiresAt <= now) return row;
  return {
    ...row,
    cooldownExpiresAt: cooldown.expiresAt.toISOString(),
    consecutiveHits: cooldown.consecutiveHits ?? null,
    hasLiveState: true,
  };
}

function parseScopedRedisKey(key: string, prefix: string): ScopedRedisKey | null {
  if (!key.startsWith(`${prefix}:`)) return null;
  const rest = key.slice(prefix.length + 1);
  const providerEnd = rest.indexOf(":");
  if (providerEnd === -1) return null;
  const providerId = rest.slice(0, providerEnd);
  const scopePart = rest.slice(providerEnd + 1);
  if (scopePart === "provider") {
    return { providerId, scope: "provider", userId: null };
  }
  if (scopePart.startsWith("user:")) {
    const userId = scopePart.slice("user:".length);
    return { providerId, scope: "user", userId: userId === "unknown" ? null : userId };
  }
  return null;
}

function shouldIncludeUserAdaptiveRow(state: ProviderAdaptiveRateState, nowMs: number): boolean {
  const slid = slideAdaptiveWindow(state, nowMs);
  if (slid.requestCount > 0) return true;
  const defaultBudget = defaultInferredBudget(slid.providerId);
  if (slid.inferredBudget != null && slid.inferredBudget !== defaultBudget) return true;
  if (slid.observedCooldownSeconds != null) return true;
  if (slid.throttleMs !== defaultThrottleMs(slid.providerId)) return true;
  if (slid.stravaShortLimit != null || slid.stravaDailyLimit != null) return true;
  return false;
}

async function scanKeys(redis: RedisReader, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", "100");
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function sortRows(rows: ProviderRateLimitStatusRow[]): ProviderRateLimitStatusRow[] {
  return rows.sort((left, right) => {
    const providerCompare = left.providerId.localeCompare(right.providerId);
    if (providerCompare !== 0) return providerCompare;
    if (left.scope !== right.scope) return left.scope === "provider" ? -1 : 1;
    return (left.userId ?? "").localeCompare(right.userId ?? "");
  });
}

export async function getProviderRateLimitStatus(
  redisReader: RedisReader,
  now = new Date(),
): Promise<ProviderRateLimitStatusRow[]> {
  const nowMs = now.getTime();
  const rows = new Map<string, ProviderRateLimitStatusRow>();

  for (const providerId of getConfiguredProviderIds()) {
    rows.set(rowKey(providerId, "provider", null), buildBaseRow(providerId, "provider", null));
  }

  const [adaptiveKeys, cooldownKeys] = await Promise.all([
    scanKeys(redisReader, `${ADAPTIVE_RATE_STORAGE_KEY_PREFIX}:*`),
    scanKeys(redisReader, `${COOLDOWN_KEY_PREFIX}:*`),
  ]);

  for (const key of adaptiveKeys) {
    const parsed = parseScopedRedisKey(key, ADAPTIVE_RATE_STORAGE_KEY_PREFIX);
    if (!parsed) continue;
    if (parsed.scope === "user" && parsed.userId == null) continue;

    const raw = await redisReader.get(key);
    const state = parseAdaptiveRateState(raw);
    if (!state) continue;
    if (parsed.scope === "user" && !shouldIncludeUserAdaptiveRow(state, nowMs)) continue;

    const keyForRow = rowKey(parsed.providerId, parsed.scope, parsed.userId);
    const existing =
      rows.get(keyForRow) ?? buildBaseRow(parsed.providerId, parsed.scope, parsed.userId);
    rows.set(keyForRow, applyAdaptiveState(existing, state, nowMs));
  }

  for (const key of cooldownKeys) {
    const parsed = parseScopedRedisKey(key, COOLDOWN_KEY_PREFIX);
    if (!parsed) continue;
    if (parsed.scope === "user" && parsed.userId == null) continue;

    const raw = await redisReader.get(key);
    const cooldown = parseProviderRateLimitCooldown(raw);
    if (!cooldown || cooldown.expiresAt <= now) continue;

    const keyForRow = rowKey(parsed.providerId, parsed.scope, parsed.userId);
    const existing =
      rows.get(keyForRow) ?? buildBaseRow(parsed.providerId, parsed.scope, parsed.userId);
    rows.set(keyForRow, applyCooldown(existing, cooldown, now));
  }

  return sortRows([...rows.values()]);
}

async function getSharedRedisReader(): Promise<RedisReader> {
  const connection = getSharedRedisConnection();
  const redisClient = await connection.client;
  return {
    get: async (key) => redisClient.get(key),
    scan: async (cursor, matchKeyword, pattern, countKeyword, count) =>
      redisClient.scan(cursor, matchKeyword, pattern, countKeyword, count),
  };
}

export async function getProviderRateLimitStatusFromRedis(
  now = new Date(),
): Promise<ProviderRateLimitStatusRow[]> {
  return getProviderRateLimitStatus(await getSharedRedisReader(), now);
}
