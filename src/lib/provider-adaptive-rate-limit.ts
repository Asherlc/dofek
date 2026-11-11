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

interface RedisClient {
  get: (key: string) => Promise<string | null>;
  eval: (script: string, numberOfKeys: number, ...args: (string | number)[]) => Promise<unknown>;
}

// WATCH belongs to the connection, so concurrent callers must compare and write
// in one Redis operation. Keep pacing calculations in the shared TypeScript code.
const COMPARE_AND_SET_ADAPTIVE_STATE = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and current ~= false) or
   (ARGV[1] == '1' and current ~= ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
return 1
`;

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

function recordAdaptiveSuccess(
  state: ProviderAdaptiveRateState,
  responseHeaders?: Headers,
): ProviderAdaptiveRateState {
  const nowMs = Date.now();
  let next = slideAdaptiveWindow(state, nowMs);
  if (state.providerId === "strava" && responseHeaders) {
    const quota = parseStravaRateLimitHeaders(responseHeaders);
    if (quota) {
      next = applyStravaQuota(next, quota);
      if (next.lastRequestMs == null) {
        next = { ...next, lastRequestMs: nowMs };
      }
    }
  }
  return next;
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
    await this.#save(
      recordAdaptiveSuccess(await this.#loadOrCreate(providerId, scope, userId), responseHeaders),
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
    get: async (key) => redisClient.get(key),
    eval: async (script, numberOfKeys, ...args) => redisClient.eval(script, numberOfKeys, ...args),
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

  async #updateState(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    update: (
      state: ProviderAdaptiveRateState,
    ) => ProviderAdaptiveRateState | Promise<ProviderAdaptiveRateState>,
  ): Promise<void> {
    const key = adaptiveRateLimitStorageKey(providerId, scope, userId);
    const redisClient = await this.#getRedisClient();
    while (true) {
      const raw = await redisClient.get(key);
      const state = loadAdaptiveStateFromRedis(raw, providerId, scope, userId, Date.now());
      const next = await update(state);
      const saved = await redisClient.eval(
        COMPARE_AND_SET_ADAPTIVE_STATE,
        1,
        key,
        raw === null ? "0" : "1",
        raw ?? "",
        serializeAdaptiveRateState(next),
        ADAPTIVE_RATE_WINDOW_MS * 4,
      );
      if (saved === 1) return;
    }
  }

  async awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void> {
    const throttleOnly =
      shouldUseSyncStepThrottleOnly(providerId) ||
      (shouldClaimSyncStepBudget(providerId) && !tryClaimSyncStepAdmission());
    await this.#updateState(providerId, scope, userId, async (state) => {
      const delay = throttleOnly
        ? throttleDelayMs(state, Date.now())
        : admissionDelayMs(state, Date.now());
      await sleep(delay);
      return throttleOnly
        ? recordAdaptiveThrottleTouch(state, Date.now())
        : recordAdaptiveRequest(state, Date.now());
    });
  }

  async recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void> {
    await this.#updateState(providerId, scope, userId, (state) =>
      recordAdaptiveSuccess(state, responseHeaders),
    );
  }

  async recordRateLimit(error: ProviderRateLimitError): Promise<void> {
    await this.#updateState(
      error.providerId,
      error.scope,
      error.scope === "user" ? error.userId : null,
      (state) => recordAdaptiveRateLimit(state, error.retryAfterSeconds),
    );
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
