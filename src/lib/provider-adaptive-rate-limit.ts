import {
  ADAPTIVE_RATE_WINDOW_MS,
  type AdaptiveRateLimitStore,
  adaptiveRateLimitStorageKey,
  admissionDelayMs,
  applyStravaQuota,
  createInitialAdaptiveState,
  isStepChainSyncProvider,
  type ProviderAdaptiveRateState,
  parseAdaptiveRateState,
  parseStravaRateLimitHeaders,
  recordAdaptiveRateLimit,
  recordAdaptiveRequest,
  recordAdaptiveThrottleTouch,
  serializeAdaptiveRateState,
  slideAdaptiveWindow,
  throttleDelayMs,
} from "@dofek/provider-http/adaptive-rate-limit";
import type {
  ProviderRateLimitError,
  ProviderRateLimitScope,
} from "@dofek/provider-http/rate-limit";
import { getSharedRedisConnection } from "../jobs/queues.ts";
import {
  hasSyncStepAdmissionClaimed,
  isInsideSyncStepAdmission,
  tryClaimSyncStepAdmission,
} from "./sync-step-admission-context.ts";

interface RedisMulti {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => RedisMulti;
  exec: () => Promise<unknown[] | null>;
}

interface RedisClient {
  set: (key: string, value: string, mode: "PX", millisecondsToExpire: number) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  watch?: (key: string) => Promise<unknown>;
  unwatch?: () => Promise<unknown>;
  multi?: () => RedisMulti;
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

async function awaitThrottleWithStore(
  loadOrCreate: LoadOrCreate,
  save: SaveState,
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
): Promise<void> {
  const nowMs = Date.now();
  const state = slideAdaptiveWindow(await loadOrCreate(providerId, scope, userId), nowMs);
  await sleep(throttleDelayMs(state, nowMs));
  const touchedAtMs = Date.now();
  const touchedState = slideAdaptiveWindow(state, touchedAtMs);
  await save(recordAdaptiveThrottleTouch(touchedState, touchedAtMs));
}

function shouldUseSyncStepThrottleOnly(providerId: string): boolean {
  return (
    isStepChainSyncProvider(providerId) &&
    isInsideSyncStepAdmission() &&
    hasSyncStepAdmissionClaimed()
  );
}

function shouldClaimSyncStepBudget(providerId: string): boolean {
  return isStepChainSyncProvider(providerId) && isInsideSyncStepAdmission();
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
  const admittedAtMs = Date.now();
  const admittedState = slideAdaptiveWindow(state, admittedAtMs);
  await save(recordAdaptiveRequest(admittedState, admittedAtMs));
}

function loadAdaptiveStateFromRedis(
  raw: string | null,
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
  nowMs: number,
): ProviderAdaptiveRateState {
  return slideAdaptiveWindow(
    parseAdaptiveRateState(raw) ?? createInitialAdaptiveState(providerId, scope, userId, nowMs),
    nowMs,
  );
}

async function awaitAdmissionAtomically(
  redisClient: RedisClient,
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
): Promise<void> {
  const key = adaptiveRateLimitStorageKey(providerId, scope, userId);
  const watch = redisClient.watch;
  const multi = redisClient.multi;
  if (!watch || !multi) {
    throw new Error("Redis client does not support atomic admission");
  }

  while (true) {
    const planningMs = Date.now();
    const planningState = loadAdaptiveStateFromRedis(
      await redisClient.get(key),
      providerId,
      scope,
      userId,
      planningMs,
    );
    await sleep(admissionDelayMs(planningState, planningMs));

    while (true) {
      await watch(key);
      const claimMs = Date.now();
      const claimState = loadAdaptiveStateFromRedis(
        await redisClient.get(key),
        providerId,
        scope,
        userId,
        claimMs,
      );
      const remainingDelay = admissionDelayMs(claimState, claimMs);
      if (remainingDelay > 0) {
        await redisClient.unwatch?.();
        await sleep(remainingDelay);
        break;
      }

      const nextState = recordAdaptiveRequest(claimState, claimMs);
      const execResult = await multi()
        .set(key, serializeAdaptiveRateState(nextState), "PX", ADAPTIVE_RATE_WINDOW_MS * 4)
        .exec();
      if (execResult) {
        return;
      }
    }
  }
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
  const nowMs = Date.now();
  let next = slideAdaptiveWindow(state, nowMs);
  if (providerId === "strava" && responseHeaders) {
    const quota = parseStravaRateLimitHeaders(responseHeaders);
    if (quota) {
      next = applyStravaQuota(next, quota);
      if (next.lastRequestMs == null) {
        next = { ...next, lastRequestMs: nowMs };
      }
    }
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
    if (shouldUseSyncStepThrottleOnly(providerId)) {
      await awaitThrottleWithStore(
        this.#loadOrCreate.bind(this),
        this.#save.bind(this),
        providerId,
        scope,
        userId,
      );
      return;
    }

    if (shouldClaimSyncStepBudget(providerId) && !tryClaimSyncStepAdmission()) {
      await awaitThrottleWithStore(
        this.#loadOrCreate.bind(this),
        this.#save.bind(this),
        providerId,
        scope,
        userId,
      );
      return;
    }

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

async function getSharedRedisClient(): Promise<RedisClient> {
  const connection = getSharedRedisConnection();
  const redisClient = await connection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire) =>
      redisClient.set(key, value, mode, millisecondsToExpire),
    get: async (key) => redisClient.get(key),
    watch: async (key) => redisClient.watch(key),
    unwatch: async () => redisClient.unwatch(),
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
    if (shouldUseSyncStepThrottleOnly(providerId)) {
      await awaitThrottleWithStore(
        this.#loadOrCreate.bind(this),
        this.#save.bind(this),
        providerId,
        scope,
        userId,
      );
      return;
    }

    if (shouldClaimSyncStepBudget(providerId) && !tryClaimSyncStepAdmission()) {
      await awaitThrottleWithStore(
        this.#loadOrCreate.bind(this),
        this.#save.bind(this),
        providerId,
        scope,
        userId,
      );
      return;
    }

    const redisClient = await this.#getRedisClient();
    if (redisClient.watch && redisClient.multi) {
      await awaitAdmissionAtomically(redisClient, providerId, scope, userId);
      return;
    }
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
