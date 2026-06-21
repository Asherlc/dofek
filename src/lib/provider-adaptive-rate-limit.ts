import {
  ADAPTIVE_RATE_WINDOW_MS,
  admissionDelayMs,
  applyStravaQuota,
  createInitialAdaptiveState,
  type AdaptiveRateLimitStore,
  type ProviderAdaptiveRateState,
  parseStravaRateLimitHeaders,
  recordAdaptiveRateLimit,
  recordAdaptiveRequest,
  slideAdaptiveWindow,
} from "@dofek/provider-http/adaptive-rate-limit";
import type { ProviderRateLimitError, ProviderRateLimitScope } from "@dofek/provider-http/rate-limit";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "../jobs/queues.ts";

interface RedisClient {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
}

const KEY_PREFIX = "provider-adaptive-rate";

function adaptiveKey(
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
): string {
  return scope === "provider"
    ? `${KEY_PREFIX}:${providerId}:provider`
    : `${KEY_PREFIX}:${providerId}:user:${userId ?? "unknown"}`;
}

function serializeState(state: ProviderAdaptiveRateState): string {
  return JSON.stringify(state);
}

function parseState(raw: string | null): ProviderAdaptiveRateState | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;

  const providerId = Reflect.get(parsed, "providerId");
  const scope = Reflect.get(parsed, "scope");
  const userId = Reflect.get(parsed, "userId");
  const windowStartMs = Reflect.get(parsed, "windowStartMs");
  const requestCount = Reflect.get(parsed, "requestCount");
  const throttleMs = Reflect.get(parsed, "throttleMs");
  const lastRequestMs = Reflect.get(parsed, "lastRequestMs");
  const inferredBudget = Reflect.get(parsed, "inferredBudget");
  const observedCooldownSeconds = Reflect.get(parsed, "observedCooldownSeconds");
  const stravaShortLimit = Reflect.get(parsed, "stravaShortLimit");
  const stravaShortUsage = Reflect.get(parsed, "stravaShortUsage");
  const stravaDailyLimit = Reflect.get(parsed, "stravaDailyLimit");
  const stravaDailyUsage = Reflect.get(parsed, "stravaDailyUsage");

  if (typeof providerId !== "string") return null;
  if (scope !== "provider" && scope !== "user") return null;
  if (userId !== null && typeof userId !== "string") return null;
  if (typeof windowStartMs !== "number" || !Number.isFinite(windowStartMs)) return null;
  if (typeof requestCount !== "number" || !Number.isFinite(requestCount)) return null;
  if (typeof throttleMs !== "number" || !Number.isFinite(throttleMs)) return null;
  if (lastRequestMs !== null && (typeof lastRequestMs !== "number" || !Number.isFinite(lastRequestMs))) {
    return null;
  }

  return {
    providerId,
    scope,
    userId,
    windowStartMs,
    requestCount,
    throttleMs,
    lastRequestMs,
    inferredBudget:
      typeof inferredBudget === "number" && Number.isFinite(inferredBudget) ? inferredBudget : null,
    observedCooldownSeconds:
      typeof observedCooldownSeconds === "number" && Number.isFinite(observedCooldownSeconds)
        ? observedCooldownSeconds
        : null,
    stravaShortLimit:
      typeof stravaShortLimit === "number" && Number.isFinite(stravaShortLimit)
        ? stravaShortLimit
        : null,
    stravaShortUsage:
      typeof stravaShortUsage === "number" && Number.isFinite(stravaShortUsage)
        ? stravaShortUsage
        : null,
    stravaDailyLimit:
      typeof stravaDailyLimit === "number" && Number.isFinite(stravaDailyLimit)
        ? stravaDailyLimit
        : null,
    stravaDailyUsage:
      typeof stravaDailyUsage === "number" && Number.isFinite(stravaDailyUsage)
        ? stravaDailyUsage
        : null,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InMemoryAdaptiveRateLimitStore implements AdaptiveRateLimitStore {
  readonly #states = new Map<string, ProviderAdaptiveRateState>();

  async #loadOrCreate(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<ProviderAdaptiveRateState> {
    const key = adaptiveKey(providerId, scope, userId);
    const existing = this.#states.get(key);
    if (existing) return existing;
    const initial = createInitialAdaptiveState(providerId, scope, userId);
    this.#states.set(key, initial);
    return initial;
  }

  async #save(state: ProviderAdaptiveRateState): Promise<void> {
    this.#states.set(adaptiveKey(state.providerId, state.scope, state.userId), state);
  }

  async awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void> {
    const nowMs = Date.now();
    const state = slideAdaptiveWindow(await this.#loadOrCreate(providerId, scope, userId), nowMs);
    await sleep(admissionDelayMs(state, nowMs));
    await this.#save(recordAdaptiveRequest(state, nowMs));
  }

  async recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void> {
    const state = await this.#loadOrCreate(providerId, scope, userId);
    let next = slideAdaptiveWindow(state, Date.now());
    if (providerId === "strava" && responseHeaders) {
      const quota = parseStravaRateLimitHeaders(responseHeaders);
      if (quota) next = applyStravaQuota(next, quota);
    }
    await this.#save(next);
  }

  async recordRateLimit(error: ProviderRateLimitError): Promise<void> {
    const scope = error.scope;
    const userId = scope === "user" ? error.userId : null;
    const state = await this.#loadOrCreate(error.providerId, scope, userId);
    await this.#save(recordAdaptiveRateLimit(state, error.retryAfterSeconds));
  }

  async getLearnedCooldownSeconds(providerId: string): Promise<number | null> {
    const state = await this.#loadOrCreate(providerId, "provider", null);
    return state.observedCooldownSeconds;
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

export class RedisAdaptiveRateLimitStore implements AdaptiveRateLimitStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async #loadOrCreate(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<ProviderAdaptiveRateState> {
    const key = adaptiveKey(providerId, scope, userId);
    const redisClient = await this.#getRedisClient();
    const existing = parseState(await redisClient.get(key));
    if (existing) return existing;
    return createInitialAdaptiveState(providerId, scope, userId);
  }

  async #save(state: ProviderAdaptiveRateState): Promise<void> {
    const key = adaptiveKey(state.providerId, state.scope, state.userId);
    const redisClient = await this.#getRedisClient();
    await redisClient.set(key, serializeState(state), "PX", ADAPTIVE_RATE_WINDOW_MS * 4);
  }

  async awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void> {
    const nowMs = Date.now();
    const state = slideAdaptiveWindow(await this.#loadOrCreate(providerId, scope, userId), nowMs);
    await sleep(admissionDelayMs(state, nowMs));
    await this.#save(recordAdaptiveRequest(state, nowMs));
  }

  async recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void> {
    const state = await this.#loadOrCreate(providerId, scope, userId);
    let next = slideAdaptiveWindow(state, Date.now());
    if (providerId === "strava" && responseHeaders) {
      const quota = parseStravaRateLimitHeaders(responseHeaders);
      if (quota) next = applyStravaQuota(next, quota);
    }
    await this.#save(next);
  }

  async recordRateLimit(error: ProviderRateLimitError): Promise<void> {
    const scope = error.scope;
    const userId = scope === "user" ? error.userId : null;
    const state = await this.#loadOrCreate(error.providerId, scope, userId);
    await this.#save(recordAdaptiveRateLimit(state, error.retryAfterSeconds));
  }

  async getLearnedCooldownSeconds(providerId: string): Promise<number | null> {
    const state = await this.#loadOrCreate(providerId, "provider", null);
    return state.observedCooldownSeconds;
  }
}

export const providerAdaptiveRateLimitStore: AdaptiveRateLimitStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryAdaptiveRateLimitStore()
    : new RedisAdaptiveRateLimitStore();
