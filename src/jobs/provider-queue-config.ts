/**
 * Static configuration for per-provider sync queues.
 *
 * Each provider can have its own BullMQ rate limiter and concurrency settings,
 * plus a sync tier that controls how frequently it is polled by the scheduler.
 */

// ── Types ──

/** How often a provider should be polled by the scheduler. */
export type ProviderSyncTier = "realtime" | "frequent" | "daily" | "on-demand";

/** BullMQ-compatible rate limiter shape. */
export interface RateLimiterConfig {
  /** Maximum number of jobs processed within `duration` ms. */
  max: number;
  /** Time window in milliseconds. */
  duration: number;
}

/** Per-provider queue configuration. */
export interface ProviderQueueConfig {
  /** BullMQ rate limiter — omit if the provider has no documented API rate limit. */
  limiter?: RateLimiterConfig;
  /** Max concurrent jobs for this provider's worker. */
  concurrency: number;
  /** Scheduling tier — controls polling frequency. */
  syncTier: ProviderSyncTier;
}

// ── Default ──

export const DEFAULT_QUEUE_CONFIG: ProviderQueueConfig = {
  concurrency: 3,
  syncTier: "frequent",
};

// ── Provider configs ──

function realtimeProvider(concurrency = 3, limiter?: RateLimiterConfig): ProviderQueueConfig {
  return { concurrency, syncTier: "realtime", limiter };
}

function frequentProvider(concurrency = 3, limiter?: RateLimiterConfig): ProviderQueueConfig {
  return { concurrency, syncTier: "frequent", limiter };
}

/**
 * Known provider queue configurations.
 *
 * Rate limits are sourced from official API documentation where available.
 * Concurrency is conservative to avoid hitting undocumented soft limits.
 */
const PROVIDER_QUEUE_CONFIGS: ReadonlyMap<string, ProviderQueueConfig> = new Map([
  // ── Providers with documented rate limits ──
  // Strava: 100 req/15min (using 90 for safety margin)
  ["strava", realtimeProvider(2, { max: 90, duration: 15 * 60_000 })],
  // Withings: 120 req/min
  ["withings", realtimeProvider(2, { max: 120, duration: 60_000 })],
  // Fitbit: 150 req/hour
  ["fitbit", frequentProvider(2, { max: 150, duration: 60 * 60_000 })],

  // ── Realtime tier (no documented rate limit) ──
  ["garmin", realtimeProvider()],
  ["wahoo", realtimeProvider()],
  ["polar", realtimeProvider()],
  ["ride-with-gps", realtimeProvider()],
  ["suunto", realtimeProvider()],
  ["coros", realtimeProvider()],
  ["komoot", realtimeProvider()],
  ["decathlon", realtimeProvider()],
  ["velohero", realtimeProvider()],
  ["xert", realtimeProvider()],
  ["cycling_analytics", realtimeProvider()],
  ["mapmyfitness", realtimeProvider()],

  // ── Frequent tier ──
  ["whoop", frequentProvider()],
  ["oura", frequentProvider()],
  ["peloton", frequentProvider()],
  ["ultrahuman", frequentProvider()],
  ["trainerroad", frequentProvider()],
  ["eight-sleep", frequentProvider()],
  ["zwift", frequentProvider()],
  ["wger", frequentProvider()],
  ["concept2", frequentProvider()],
  ["auto-supplements", frequentProvider()],

  // ── Daily tier ──
  ["fatsecret", { concurrency: 2, syncTier: "daily" }],

  // ── On-demand tier ──
  ["bodyspec", { concurrency: 1, syncTier: "on-demand" }],
]);

// ── Public API ──

/** Get the queue configuration for a provider, falling back to the default. */
export function getProviderQueueConfig(providerId: string): ProviderQueueConfig {
  return PROVIDER_QUEUE_CONFIGS.get(providerId) ?? DEFAULT_QUEUE_CONFIG;
}

/** Get all provider IDs that have explicit queue configurations. */
export function getConfiguredProviderIds(): string[] {
  return [...PROVIDER_QUEUE_CONFIGS.keys()];
}
