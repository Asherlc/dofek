interface SyncCardHistory {
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  recentLogs: ReadonlyArray<{ status: string; syncedAt: string }>;
}

interface SyncCardIssue {
  status: "error" | "degraded";
  label: string;
  accessibilityLabel: string;
}

function issuePriority(status: string): number {
  return status === "error" ? 2 : status === "degraded" ? 1 : 0;
}

export function syncCardSummary(history: SyncCardHistory) {
  const latestLog = history.recentLogs.reduce<(typeof history.recentLogs)[number] | null>(
    (latest, log) =>
      !latest ||
      log.syncedAt > latest.syncedAt ||
      (log.syncedAt === latest.syncedAt && issuePriority(log.status) > issuePriority(latest.status))
        ? log
        : latest,
    null,
  );
  const latestIssue: SyncCardIssue | null =
    latestLog?.status === "error"
      ? { status: "error", label: "Latest sync failed", accessibilityLabel: "Sync needs attention" }
      : latestLog?.status === "degraded"
        ? {
            status: "degraded",
            label: "Latest sync completed with issues",
            accessibilityLabel: "Sync completed with issues",
          }
        : null;
  const attemptedAt = latestIssue ? (latestLog?.syncedAt ?? null) : history.lastSyncAt;

  return {
    lastAttemptAt:
      attemptedAt === history.lastSuccessfulSyncAt && !latestIssue ? null : attemptedAt,
    lastSuccessfulSyncAt: history.lastSuccessfulSyncAt,
    latestIssue,
    hasHistory:
      history.lastSyncAt !== null || history.lastSuccessfulSyncAt !== null || latestLog !== null,
  };
}
