import type { ProcessingDisplayStatus } from "./processing-status.ts";
import { providerSyncLogPresentation } from "./sync-log-presentation.ts";

export interface ProviderSyncHistory {
  needsReauth?: boolean;
  lastSuccessfulSyncAt: string | null;
  recentLogs: ReadonlyArray<{
    status: string;
    syncedAt: string;
    dataType?: string;
    authFailureReason?: string | null;
    errorMessage?: string | null;
  }>;
}

interface SyncCardHistory extends ProviderSyncHistory {
  lastSyncAt: string | null;
}

interface SyncCardIssue {
  status: "error" | "degraded";
  label: string;
  accessibilityLabel: string;
}

function issuePriority(status: string): number {
  return status === "error" ? 2 : status === "degraded" ? 1 : 0;
}

function latestSyncLog(history: ProviderSyncHistory) {
  return history.recentLogs.reduce<(typeof history.recentLogs)[number] | null>(
    (latest, log) =>
      !latest ||
      log.syncedAt > latest.syncedAt ||
      (log.syncedAt === latest.syncedAt && issuePriority(log.status) > issuePriority(latest.status))
        ? log
        : latest,
    null,
  );
}

interface ProviderProcessingEvidence {
  status: ProcessingDisplayStatus;
  datasets: ReadonlyArray<{
    status: ProcessingDisplayStatus;
    lastAdvancedAt: string | null;
    lastReadyAt: string | null;
    lastFailedAt: string | null;
  }>;
  operations: ReadonlyArray<{
    status: ProcessingDisplayStatus;
    dismissed: boolean;
    createdAt: string;
    timeline: ReadonlyArray<{ occurredAt: string }>;
  }>;
}

interface ProviderSyncStatusPresentation {
  occurredAt: string | null;
  heading: string;
  message: string | null;
  status: ProcessingDisplayStatus;
  tone: "success" | "warning" | "danger" | "neutral";
}

/** A null presentation preserves the newer processing snapshot and its details. */
export function providerSyncStatusPresentation(
  providerName: string,
  history: ProviderSyncHistory,
  processing: ProviderProcessingEvidence,
): ProviderSyncStatusPresentation | null {
  const latestLog = latestSyncLog(history);
  const outcome =
    history.lastSuccessfulSyncAt &&
    (!latestLog || history.lastSuccessfulSyncAt > latestLog.syncedAt)
      ? { status: "success", syncedAt: history.lastSuccessfulSyncAt }
      : latestLog;
  const processingEvidence = [
    ...processing.datasets.map((dataset) => ({
      status: dataset.status,
      occurredAt:
        dataset.status === "ready"
          ? dataset.lastReadyAt
          : dataset.status === "failed"
            ? dataset.lastFailedAt
            : dataset.lastAdvancedAt,
    })),
    ...processing.operations
      .filter((operation) => !operation.dismissed)
      .flatMap((operation) => [
        { status: operation.status, occurredAt: operation.createdAt },
        ...operation.timeline.map((event) => ({
          status: operation.status,
          occurredAt: event.occurredAt,
        })),
      ]),
  ].filter(
    (evidence): evidence is { status: ProcessingDisplayStatus; occurredAt: string } =>
      evidence.occurredAt !== null,
  );
  const latestProcessing = processingEvidence.reduce<(typeof processingEvidence)[number] | null>(
    (latest, evidence) =>
      !latest ||
      evidence.occurredAt > latest.occurredAt ||
      (evidence.occurredAt === latest.occurredAt && evidence.status === "failed")
        ? evidence
        : latest,
    null,
  );
  // Operations include history; current dataset states establish unfinished work.
  const unfinished = processing.datasets.some(
    (dataset) => !["ready", "failed", "cancelled"].includes(dataset.status),
  );
  if (
    latestProcessing &&
    (!outcome ||
      (unfinished && outcome.status === "success") ||
      latestProcessing.occurredAt > outcome.syncedAt ||
      (latestProcessing.occurredAt === outcome.syncedAt &&
        (latestProcessing.status === "failed" ||
          (latestProcessing.status !== "ready" &&
            outcome.status !== "error" &&
            outcome.status !== "degraded"))))
  ) {
    return null;
  }
  if (!outcome) {
    return {
      occurredAt: null,
      heading: "No sync outcome recorded",
      message: null,
      status: "cancelled",
      tone: "neutral",
    };
  }
  if (outcome.status === "success") {
    return {
      occurredAt: outcome.syncedAt,
      heading: `${providerName} sync complete`,
      message: null,
      status: "ready",
      tone: "success",
    };
  }
  if (outcome.status !== "error" && outcome.status !== "degraded") {
    return {
      occurredAt: outcome.syncedAt,
      heading: "Sync outcome unavailable",
      message: "Open Diagnostics for the raw sync status.",
      status: "cancelled",
      tone: "neutral",
    };
  }
  const logPresentation = providerSyncLogPresentation({
    providerName,
    dataType: latestLog?.dataType ?? "data",
    status: outcome.status,
    authFailureReason: history.needsReauth ? (latestLog?.authFailureReason ?? null) : null,
  });
  return {
    occurredAt: outcome.syncedAt,
    heading:
      outcome.status === "error"
        ? `Latest ${providerName} sync failed`
        : `${providerName} sync completed with issues`,
    message: logPresentation.message,
    status: outcome.status === "error" ? "failed" : "blocked",
    tone: logPresentation.tone,
  };
}

export function syncCardSummary(history: SyncCardHistory) {
  const latestLog = latestSyncLog(history);
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
