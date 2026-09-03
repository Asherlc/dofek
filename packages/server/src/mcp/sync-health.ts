import type { ProviderScheduledSyncHealth } from "../repositories/sync-repository.ts";

const EXPECTED_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export function syncHealth(health: ProviderScheduledSyncHealth | undefined) {
  const lastSuccess = health?.lastSuccess;
  return {
    last_success: lastSuccess ?? null,
    last_attempt: health?.lastAttempt ?? null,
    last_error: health?.lastError ?? null,
    consecutive_failures: health?.consecutiveFailures ?? 0,
    expected_sync_interval_minutes: EXPECTED_SYNC_INTERVAL_MS / 60_000,
    stale:
      lastSuccess == null ||
      Date.now() - new Date(lastSuccess).getTime() > EXPECTED_SYNC_INTERVAL_MS * 3,
  };
}
