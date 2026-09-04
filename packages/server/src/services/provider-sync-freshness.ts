export type ProviderSyncFreshness =
  | {
      status: "unknown";
      label: "Sync status unknown";
      description: string;
    }
  | {
      status: "current";
      label: "Sync current";
    }
  | {
      status: "overdue";
      label: "Sync overdue";
      description: string;
    }
  | {
      status: "deferred";
      label: "Sync deferred";
      description: string;
    };

interface ProviderSyncFreshnessInput {
  now: Date;
  lastSuccessfulSyncAt: Date | null;
  intervalMinutes: number;
  cooldownUntil?: Date | null;
}

export function evaluateProviderSyncFreshness({
  now,
  lastSuccessfulSyncAt,
  intervalMinutes,
  cooldownUntil,
}: ProviderSyncFreshnessInput): ProviderSyncFreshness {
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) {
    return {
      status: "deferred",
      label: "Sync deferred",
      description: `Rate limited until ${cooldownUntil.toISOString()}.`,
    };
  }

  if (!lastSuccessfulSyncAt) {
    return {
      status: "unknown",
      label: "Sync status unknown",
      description: "No successful sync has been recorded.",
    };
  }

  const overdueAfterMilliseconds = intervalMinutes * 2 * 60 * 1000;
  const elapsedMilliseconds = now.getTime() - lastSuccessfulSyncAt.getTime();

  if (elapsedMilliseconds <= overdueAfterMilliseconds) {
    return {
      status: "current",
      label: "Sync current",
    };
  }

  return {
    status: "overdue",
    label: "Sync overdue",
    description: "The last successful sync is overdue.",
  };
}
