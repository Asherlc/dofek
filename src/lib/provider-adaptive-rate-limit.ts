import {
  ADAPTIVE_RATE_WINDOW_MS,
  type AdaptiveRateLimitStore,
  adaptiveRateLimitStorageKey,
  admissionDelayMs,
  applyStravaQuota,
  createInitialAdaptiveState,
  type ProviderAdaptiveRateState,
  parseAdaptiveRateState,
  parseStravaRateLimitHeaders,
  recordAdaptiveRateLimit,
  recordAdaptiveRequest,
  serializeAdaptiveRateState,
  slideAdaptiveWindow,
} from "@dofek/provider-http/adaptive-rate-limit";
import type {
  ProviderRateLimitError,
  ProviderRateLimitScope,
} from "@dofek/provider-http/rate-limit";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "../jobs/queues.ts";

interface RedisClient {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
}

type LoadOrCreate = (
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
) => Promise<ProviderAdaptiveRateState>;

type SaveState = (state: ProviderAdaptiveRateState) => Promise<void>;

function shouldSkipAdmissionDelay(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0 || shouldSkipAdmissionDelay()) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitAdmissionWithStore(
  loadOrCreate: LoadOrCreate,
  save: SaveState,
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
): Promise<void> {
  const nowMs = Date.now();
  const state = slideAdaptiveWindow(await loadOrCreate(providerId, scope, userId), nowMs);
  await sleep(admissionDelayMs(state, nowMs));
  await save(recordAdaptiveRequest(state, nowMs));
}

async function recordSuccessWithStore(
  loadOrCreate: LoadOrCreate,
  save: SaveState,
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
  responseHeaders?: Headers,
): Promise<void> {
  const state = await loadOrCreate(providerId, scope, userId);
  let next = slideAdaptiveWindow(state, Date.now());
  if (providerId === "strava" && responseHeaders) {
    const quota = parseStravaRateLimitHeaders(responseHeaders);
    if (quota) next = applyStravaQuota(next, quota);
  }
  await save(next);
}

async function recordRateLimitWithStore(
  loadOrCreate: LoadOrCreate,
  save: SaveState,
  error: ProviderRateLimitError,
): Promise<void> {
  const scope = error.scope;
  const userId = scope === "user" ? error.userId : null;
  const state = await loadOrCreate(error.providerId, scope, userId);
  await save(recordAdaptiveRateLimit(state, error.retryAfterSeconds));
}

async function getLearnedCooldownWithStore(
  loadOrCreate: LoadOrCreate,
  providerId: string,
): Promise<number | null> {
  const state = await loadOrCreate(providerId, "provider", null);
  return state.observedCooldownSeconds;
}

export class InMemoryAdaptiveRateLimitStore implements AdaptiveRateLimitStore {
  readonly #states = new Map<string, ProviderAdaptiveRateState>();

  async #loadOrCreate(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<ProviderAdaptiveRateState> {
    const key = adaptiveRateLimitStorageKey(providerId, scope, userId);
    const existing = this.#states.get(key);
    if (existing) return existing;
    const initial = createInitialAdaptiveState(providerId, scope, userId);
    this.#states.set(key, initial);
    return initial;
  }

  async #save(state: ProviderAdaptiveRateState): Promise<void> {
    this.#states.set(
      adaptiveRateLimitStorageKey(state.providerId, state.scope, state.userId),
      state,
    );
  }

  async awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void> {
    await awaitAdmissionWithStore(
      this.#loadOrCreate.bind(this),
      this.#save.bind(this),
      providerId,
      scope,
      userId,
    );
  }

  async recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void> {
    await recordSuccessWithStore(
      this.#loadOrCreate.bind(this),
      this.#save.bind(this),
      providerId,
      scope,
      userId,
      responseHeaders,
    );
  }

  async recordRateLimit(error: ProviderRateLimitError): Promise<void> {
    await recordRateLimitWithStore(this.#loadOrCreate.bind(this), this.#save.bind(this), error);
  }

  async getLearnedCooldownSeconds(providerId: string): Promise<number | null> {
    return getLearnedCooldownWithStore(this.#loadOrCreate.bind(this), providerId);
  }
}

let sharedRedisConnection: RedisConnection | null = null;

/* Stryker disable all */
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
/* Stryker enable all */

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
    const key = adaptiveRateLimitStorageKey(providerId, scope, userId);
    const redisClient = await this.#getRedisClient();
    const existing = parseAdaptiveRateState(await redisClient.get(key));
    if (existing) return existing;
    return createInitialAdaptiveState(providerId, scope, userId);
  }

  async #save(state: ProviderAdaptiveRateState): Promise<void> {
    const key = adaptiveRateLimitStorageKey(state.providerId, state.scope, state.userId);
    const redisClient = await this.#getRedisClient();
    await redisClient.set(
      key,
      serializeAdaptiveRateState(state),
      "PX",
      ADAPTIVE_RATE_WINDOW_MS * 4,
    );
  }

  async awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void> {
    await awaitAdmissionWithStore(
      this.#loadOrCreate.bind(this),
      this.#save.bind(this),
      providerId,
      scope,
      userId,
    );
  }

  async recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void> {
    await recordSuccessWithStore(
      this.#loadOrCreate.bind(this),
      this.#save.bind(this),
      providerId,
      scope,
      userId,
      responseHeaders,
    );
  }

  async recordRateLimit(error: ProviderRateLimitError): Promise<void> {
    await recordRateLimitWithStore(this.#loadOrCreate.bind(this), this.#save.bind(this), error);
  }

  async getLearnedCooldownSeconds(providerId: string): Promise<number | null> {
    return getLearnedCooldownWithStore(this.#loadOrCreate.bind(this), providerId);
  }
}

function useInMemoryAdaptiveStore(): boolean {
  return shouldSkipAdmissionDelay();
}

export const providerAdaptiveRateLimitStore: AdaptiveRateLimitStore = useInMemoryAdaptiveStore()
  ? new InMemoryAdaptiveRateLimitStore()
  : new RedisAdaptiveRateLimitStore();
