import {
  type ProviderRateLimitCooldown,
  providerSyncDeferralMessage,
} from "dofek/jobs/provider-rate-limit-cooldown";
import type { ProviderScheduledSyncHealth } from "../repositories/sync-repository.ts";

export function syncHealth(
  health: ProviderScheduledSyncHealth | undefined,
  cooldown: Pick<ProviderRateLimitCooldown, "expiresAt" | "reason"> | null | undefined,
  intervalMinutes: number,
  accessIssue?: { message: string; action: { url: string } } | null,
) {
  const lastSuccess = health?.lastSuccess;
  return {
    last_success: lastSuccess ?? null,
    last_attempt: health?.lastAttempt ?? null,
    last_error:
      cooldown != null
        ? providerSyncDeferralMessage(cooldown)
        : accessIssue
          ? `${accessIssue.message} ${accessIssue.action.url}`
          : (health?.lastError ?? null),
    consecutive_failures: health?.consecutiveFailures ?? 0,
    expected_sync_interval_minutes: intervalMinutes,
    stale:
      lastSuccess == null ||
      Date.now() - new Date(lastSuccess).getTime() > intervalMinutes * 60_000 * 3,
  };
}
