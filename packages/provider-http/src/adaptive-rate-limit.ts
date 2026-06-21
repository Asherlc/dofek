import type { ProviderRateLimitScope } from "./rate-limit-types.ts";

/** Rolling window for request budget tally (5 minutes). */
export const ADAPTIVE_RATE_WINDOW_MS = 5 * 60 * 1000;

export const ADAPTIVE_THROTTLE_MIN_MS = 500;
export const ADAPTIVE_THROTTLE_MAX_MS = 30_000;
export const ADAPTIVE_THROTTLE_DECREASE_MS = 100;
export const ADAPTIVE_THROTTLE_INCREASE_FACTOR = 2;
export const ADAPTIVE_BUDGET_SAFETY_RATIO = 0.8;
export const ADAPTIVE_DEFAULT_INFERRED_BUDGET = 40;

export const DEFAULT_PROVIDER_THROTTLE_MS: Readonly<Record<string, number>> = {
  strava: 10_000,
  garmin: 2_000,
  whoop: 1_000,
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

export function blendObservedCooldown(
  previous: number | null,
  observedSeconds: number,
): number {
  if (!Number.isFinite(observedSeconds) || observedSeconds <= 0) return previous ?? observedSeconds;
  if (previous == null) return observedSeconds;
  return Math.round(previous * 0.7 + observedSeconds * 0.3);
}

export function slideAdaptiveWindow(
  state: ProviderAdaptiveRateState,
  nowMs: number,
): ProviderAdaptiveRateState {
  if (nowMs - state.windowStartMs < ADAPTIVE_RATE_WINDOW_MS) return state;
  return {
    ...state,
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
): number | null {
  if (requestsAtLimit <= 0) return current;
  const candidate = Math.max(1, requestsAtLimit - 1);
  if (current == null) return candidate;
  return Math.min(current, candidate);
}

export function admissionDelayMs(state: ProviderAdaptiveRateState, nowMs: number): number {
  let delayMs = 0;

  if (state.lastRequestMs != null) {
    const elapsed = nowMs - state.lastRequestMs;
    if (elapsed < state.throttleMs) {
      delayMs = state.throttleMs - elapsed;
    }
  }

  if (state.inferredBudget != null) {
    const softCap = Math.floor(state.inferredBudget * ADAPTIVE_BUDGET_SAFETY_RATIO);
    if (state.requestCount >= softCap) {
      delayMs = Math.max(delayMs, state.throttleMs);
    }
  }

  if (state.providerId === "strava" && state.stravaShortLimit != null && state.stravaShortUsage != null) {
    const remaining = state.stravaShortLimit - state.stravaShortUsage;
    if (remaining <= 2) {
      delayMs = Math.max(delayMs, state.throttleMs * 4);
    } else if (remaining <= 5) {
      delayMs = Math.max(delayMs, state.throttleMs * 2);
    } else {
      const windowMs = 15 * 60 * 1000;
      const pacedDelay = Math.ceil(windowMs / remaining);
      delayMs = Math.max(delayMs, Math.min(pacedDelay, ADAPTIVE_THROTTLE_MAX_MS));
    }
  }

  return delayMs;
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
    inferredBudget: null,
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
    inferredBudget: learnInferredBudget(state.inferredBudget, state.requestCount),
    observedCooldownSeconds: observedCooldown,
  };
}
