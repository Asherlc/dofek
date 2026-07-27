import type { ProviderRateLimitScope } from "./rate-limit-types.ts";

/** Rolling window for request budget tally (5 minutes). */
export const ADAPTIVE_RATE_WINDOW_MS = 5 * 60 * 1000;

export const ADAPTIVE_THROTTLE_MIN_MS = 500;
export const ADAPTIVE_THROTTLE_MAX_MS = 30_000;
export const ADAPTIVE_THROTTLE_DECREASE_MS = 100;
export const ADAPTIVE_THROTTLE_INCREASE_FACTOR = 2;
export const ADAPTIVE_BUDGET_SAFETY_RATIO = 0.8;
export const ADAPTIVE_DEFAULT_INFERRED_BUDGET = 40;

/**
 * Minimum rolling-window requests observed at a 429 before shrinking inferred budget.
 * Step-chain sync jobs may hit a limit after only a few HTTP calls in a fresh window;
 * skipping early learning avoids permanent over-throttling.
 */
export const ADAPTIVE_MIN_REQUESTS_FOR_BUDGET_LEARNING = 8;

export const DEFAULT_PROVIDER_THROTTLE_MS: Readonly<Record<string, number>> = {
  strava: 10_000,
  garmin: 5_000,
  whoop: 1_000,
};

/** Providers that run one BullMQ job per sync step (not one job per full sync). */
export const STEP_CHAIN_SYNC_PROVIDERS: ReadonlySet<string> = new Set(["garmin", "whoop"]);

/**
 * Typical HTTP calls per step-chain sync job (auth refresh, bootstrap, one data call).
 * Used to align BullMQ job pacing with HTTP-level adaptive budgets.
 */
export const DEFAULT_HTTP_REQUESTS_PER_SYNC_JOB: Readonly<Record<string, number>> = {
  garmin: 2,
  whoop: 3,
};

/** Seed inferred budgets for step-chain providers before the first 429 observation. */
export const DEFAULT_PROVIDER_INFERRED_BUDGET: Readonly<Record<string, number>> = {
  // Garmin's unofficial API is IP-based; keep the default budget conservative.
  garmin: 20,
  whoop: ADAPTIVE_DEFAULT_INFERRED_BUDGET,
};

export interface StravaRateLimitQuota {
  shortLimit: number;
  shortUsage: number;
  dailyLimit: number;
  dailyUsage: number;
}

export interface ProviderAdaptiveRateState {
  providerId: string;
  scope: ProviderRateLimitScope;
  userId: string | null;
  windowStartMs: number;
  requestCount: number;
  throttleMs: number;
  lastRequestMs: number | null;
  inferredBudget: number | null;
  observedCooldownSeconds: number | null;
  stravaShortLimit: number | null;
  stravaShortUsage: number | null;
  stravaDailyLimit: number | null;
  stravaDailyUsage: number | null;
}

export type { AdaptiveRateLimitStore } from "./rate-limit-types.ts";

export function defaultThrottleMs(providerId: string): number {
  return DEFAULT_PROVIDER_THROTTLE_MS[providerId] ?? 1_000;
}

export function defaultInferredBudget(providerId: string): number | null {
  return DEFAULT_PROVIDER_INFERRED_BUDGET[providerId] ?? null;
}

export function httpRequestsPerSyncJob(providerId: string): number {
  return DEFAULT_HTTP_REQUESTS_PER_SYNC_JOB[providerId] ?? 1;
}

export function isStepChainSyncProvider(providerId: string): boolean {
  return STEP_CHAIN_SYNC_PROVIDERS.has(providerId);
}

export function parseStravaRateLimitHeaders(headers: Headers): StravaRateLimitQuota | null {
  const limitHeader = headers.get("X-RateLimit-Limit");
  const usageHeader = headers.get("X-RateLimit-Usage");
  if (!limitHeader || !usageHeader) return null;

  const [shortLimitRaw, dailyLimitRaw] = limitHeader.split(",");
  const [shortUsageRaw, dailyUsageRaw] = usageHeader.split(",");
  const shortLimit = Number.parseInt(shortLimitRaw ?? "", 10);
  const dailyLimit = Number.parseInt(dailyLimitRaw ?? "", 10);
  const shortUsage = Number.parseInt(shortUsageRaw ?? "", 10);
  const dailyUsage = Number.parseInt(dailyUsageRaw ?? "", 10);
  if (
    !Number.isFinite(shortLimit) ||
    !Number.isFinite(dailyLimit) ||
    !Number.isFinite(shortUsage) ||
    !Number.isFinite(dailyUsage)
  ) {
    return null;
  }
  return { shortLimit, shortUsage, dailyLimit, dailyUsage };
}

export function blendObservedCooldown(previous: number | null, observedSeconds: number): number {
  if (!Number.isFinite(observedSeconds) || observedSeconds <= 0) return previous ?? observedSeconds;
  if (previous == null) return observedSeconds;
  return Math.round(previous * 0.7 + observedSeconds * 0.3);
}

export function slideAdaptiveWindow(
  state: ProviderAdaptiveRateState,
  nowMs: number,
): ProviderAdaptiveRateState {
  const lastRequestMs = state.lastRequestMs === null ? null : Math.min(state.lastRequestMs, nowMs);
  if (nowMs < state.windowStartMs) {
    return {
      ...state,
      lastRequestMs,
      windowStartMs: nowMs,
    };
  }
  if (nowMs - state.windowStartMs < ADAPTIVE_RATE_WINDOW_MS) {
    return lastRequestMs === state.lastRequestMs ? state : { ...state, lastRequestMs };
  }
  return {
    ...state,
    lastRequestMs,
    windowStartMs: nowMs,
    requestCount: 0,
  };
}

export function decreaseThrottleMs(throttleMs: number): number {
  return Math.max(ADAPTIVE_THROTTLE_MIN_MS, throttleMs - ADAPTIVE_THROTTLE_DECREASE_MS);
}

export function increaseThrottleMs(throttleMs: number): number {
  return Math.min(ADAPTIVE_THROTTLE_MAX_MS, throttleMs * ADAPTIVE_THROTTLE_INCREASE_FACTOR);
}

export function learnInferredBudget(
  current: number | null,
  requestsAtLimit: number,
  providerId?: string,
): number | null {
  if (requestsAtLimit <= 0) return current;
  if (requestsAtLimit < ADAPTIVE_MIN_REQUESTS_FOR_BUDGET_LEARNING) {
    return current ?? (providerId ? defaultInferredBudget(providerId) : null);
  }
  const candidate = Math.max(1, requestsAtLimit - 1);
  if (current == null) return candidate;
  return Math.min(current, candidate);
}

export function admissionDelayMs(state: ProviderAdaptiveRateState, nowMs: number): number {
  let delayMs = Math.max(throttleDelayMs(state, nowMs), budgetAdmissionDelayMs(state, nowMs));

  if (
    state.providerId === "strava" &&
    state.stravaShortLimit != null &&
    state.stravaShortUsage != null
  ) {
    const remaining = state.stravaShortLimit - state.stravaShortUsage;
    let quotaIntervalMs: number;
    if (remaining <= 2) {
      quotaIntervalMs = state.throttleMs * 4;
    } else if (remaining <= 5) {
      quotaIntervalMs = state.throttleMs * 2;
    } else {
      const windowMs = 15 * 60 * 1000;
      quotaIntervalMs = Math.min(Math.ceil(windowMs / remaining), ADAPTIVE_THROTTLE_MAX_MS);
    }
    delayMs = Math.max(
      delayMs,
      remainingIntervalDelayMs(state.lastRequestMs, quotaIntervalMs, nowMs),
    );
  }

  return delayMs;
}

export function throttleDelayMs(state: ProviderAdaptiveRateState, nowMs: number): number {
  if (state.lastRequestMs == null) return 0;
  const elapsed = nowMs - state.lastRequestMs;
  return Math.max(0, state.throttleMs - elapsed);
}

function remainingIntervalDelayMs(
  lastRequestMs: number | null,
  intervalMs: number,
  nowMs: number,
): number {
  if (lastRequestMs == null) return 0;
  return Math.max(0, intervalMs - Math.max(0, nowMs - lastRequestMs));
}

function budgetAdmissionDelayMs(state: ProviderAdaptiveRateState, nowMs: number): number {
  if (state.inferredBudget == null) return 0;

  const softCap = Math.floor(state.inferredBudget * ADAPTIVE_BUDGET_SAFETY_RATIO);
  const effectiveRequestCount = isStepChainSyncProvider(state.providerId)
    ? Math.ceil(state.requestCount / httpRequestsPerSyncJob(state.providerId))
    : state.requestCount;
  const effectiveSoftCap = isStepChainSyncProvider(state.providerId)
    ? Math.max(1, Math.floor(softCap / httpRequestsPerSyncJob(state.providerId)))
    : softCap;
  if (effectiveRequestCount >= effectiveSoftCap) {
    const elapsedMs = Math.max(0, nowMs - state.windowStartMs);
    return Math.max(0, ADAPTIVE_RATE_WINDOW_MS - elapsedMs);
  }

  return 0;
}

export function createInitialAdaptiveState(
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
  nowMs = Date.now(),
): ProviderAdaptiveRateState {
  return {
    providerId,
    scope,
    userId,
    windowStartMs: nowMs,
    requestCount: 0,
    throttleMs: defaultThrottleMs(providerId),
    lastRequestMs: null,
    inferredBudget: defaultInferredBudget(providerId),
    observedCooldownSeconds: null,
    stravaShortLimit: null,
    stravaShortUsage: null,
    stravaDailyLimit: null,
    stravaDailyUsage: null,
  };
}

export function applyStravaQuota(
  state: ProviderAdaptiveRateState,
  quota: StravaRateLimitQuota,
): ProviderAdaptiveRateState {
  return {
    ...state,
    stravaShortLimit: quota.shortLimit,
    stravaShortUsage: quota.shortUsage,
    stravaDailyLimit: quota.dailyLimit,
    stravaDailyUsage: quota.dailyUsage,
  };
}

export function recordAdaptiveRequest(
  state: ProviderAdaptiveRateState,
  nowMs: number,
): ProviderAdaptiveRateState {
  const slid = slideAdaptiveWindow(state, nowMs);
  return {
    ...slid,
    requestCount: slid.requestCount + 1,
    lastRequestMs: nowMs,
    throttleMs: decreaseThrottleMs(slid.throttleMs),
  };
}

/** Updates throttle timing without consuming a step-chain sync job budget slot. */
export function recordAdaptiveThrottleTouch(
  state: ProviderAdaptiveRateState,
  nowMs: number,
): ProviderAdaptiveRateState {
  const slid = slideAdaptiveWindow(state, nowMs);
  return {
    ...slid,
    lastRequestMs: nowMs,
    throttleMs: decreaseThrottleMs(slid.throttleMs),
  };
}

export function recordAdaptiveRateLimit(
  state: ProviderAdaptiveRateState,
  retryAfterSeconds: number | null | undefined,
): ProviderAdaptiveRateState {
  const observedCooldown =
    retryAfterSeconds != null && retryAfterSeconds > 0
      ? blendObservedCooldown(state.observedCooldownSeconds, retryAfterSeconds)
      : state.observedCooldownSeconds;

  return {
    ...state,
    throttleMs: increaseThrottleMs(state.throttleMs),
    inferredBudget: learnInferredBudget(state.inferredBudget, state.requestCount, state.providerId),
    observedCooldownSeconds: observedCooldown,
  };
}

export const ADAPTIVE_RATE_STORAGE_KEY_PREFIX = "provider-adaptive-rate";

export function adaptiveRateLimitStorageKey(
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
): string {
  return scope === "provider"
    ? `${ADAPTIVE_RATE_STORAGE_KEY_PREFIX}:${providerId}:provider`
    : `${ADAPTIVE_RATE_STORAGE_KEY_PREFIX}:${providerId}:user:${userId ?? "unknown"}`;
}

export function serializeAdaptiveRateState(state: ProviderAdaptiveRateState): string {
  return JSON.stringify(state);
}

export function parseAdaptiveRateState(raw: string | null): ProviderAdaptiveRateState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
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
  if (
    lastRequestMs !== null &&
    (typeof lastRequestMs !== "number" || !Number.isFinite(lastRequestMs))
  ) {
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
