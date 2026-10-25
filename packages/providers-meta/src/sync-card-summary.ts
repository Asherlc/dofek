import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type { ProcessingDisplayStatus } from "./processing-status.ts";
import { providerSyncLogPresentation } from "./sync-log-presentation.ts";

export interface ProviderSyncHistory {
  authorized?: boolean;
  pushOnly?: boolean;
  lastProcessedUpdateAt?: string | null;
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

function lastSuccessfulOutcomeAt(history: ProviderSyncHistory): string | null {
  return history.pushOnly ? (history.lastProcessedUpdateAt ?? null) : history.lastSuccessfulSyncAt;
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
  const lastSuccessfulAt = lastSuccessfulOutcomeAt(history);
  const outcome: ProviderSyncHistory["recentLogs"][number] | null =
    lastSuccessfulAt && (!latestLog || lastSuccessfulAt > latestLog.syncedAt)
      ? { status: "success", syncedAt: lastSuccessfulAt }
      : latestLog;
  const processingEvidence = [
    ...processing.datasets.map((dataset) => ({
      status: dataset.status,
      occurredAt: dataset.status === "failed" ? dataset.lastFailedAt : dataset.lastAdvancedAt,
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
      evidence.occurredAt !== null && (!history.pushOnly || evidence.status !== "ready"),
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
  const currentPushProcessing =
    processing.datasets.length > 0
      ? processing.datasets.some((dataset) => !["ready", "cancelled"].includes(dataset.status))
      : processing.operations.some(
          (operation) => !operation.dismissed && !["ready", "cancelled"].includes(operation.status),
        );
  if (
    latestProcessing &&
    (!history.pushOnly || currentPushProcessing) &&
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
    const missingPushOutcomeHeading = history.needsReauth
      ? `Reconnect ${providerName} to resume incoming updates`
      : history.authorized === false
        ? `Connect ${providerName} to receive updates`
        : "Waiting for first update";
    return {
      occurredAt: null,
      heading: history.pushOnly ? missingPushOutcomeHeading : "No sync outcome recorded",
      message: null,
      status: "cancelled",
      tone: "neutral",
    };
  }
  if (outcome.status === "success") {
    return {
      occurredAt: outcome.syncedAt,
      heading: history.pushOnly
        ? `${providerName} update processed`
        : `${providerName} sync complete`,
      message: null,
      status: "ready",
      tone: "success",
    };
  }
  if (outcome.status !== "error" && outcome.status !== "degraded") {
    return {
      occurredAt: outcome.syncedAt,
      heading: history.pushOnly ? "Update outcome unavailable" : "Sync outcome unavailable",
      message: history.pushOnly
        ? "Open Diagnostics for the processing status."
        : "Open Diagnostics for the raw sync status.",
      status: "cancelled",
      tone: "neutral",
    };
  }
  const logPresentation = providerSyncLogPresentation({
    providerName,
    dataType: outcome.dataType ?? "data",
    status: outcome.status,
    authFailureReason: history.needsReauth ? (outcome.authFailureReason ?? null) : null,
    pushOnly: history.pushOnly,
  });
  return {
    occurredAt: outcome.syncedAt,
    heading: history.pushOnly
      ? outcome.status === "error"
        ? `Couldn't process the latest ${providerName} update`
        : `${providerName} update processed with issues`
      : outcome.status === "error"
        ? `Latest ${providerName} sync failed`
        : `${providerName} sync completed with issues`,
    message:
      history.pushOnly && !history.needsReauth && !outcome.authFailureReason && outcome.errorMessage
        ? userFacingErrorMessage(
            outcome.errorMessage,
            logPresentation.message ?? "The update could not be processed.",
          )
        : logPresentation.message,
    status: outcome.status === "error" ? "failed" : "blocked",
    tone: logPresentation.tone,
  };
}

export function syncCardSummary(history: SyncCardHistory) {
  const latestLog = latestSyncLog(history);
  const lastSuccessfulAt = lastSuccessfulOutcomeAt(history);
  const latestIssue: SyncCardIssue | null =
    latestLog?.status === "error"
      ? {
          status: "error",
          label: history.pushOnly ? "Couldn't process the latest update" : "Latest sync failed",
          accessibilityLabel: history.pushOnly
            ? "Update processing needs attention"
            : "Sync needs attention",
        }
      : latestLog?.status === "degraded"
        ? {
            status: "degraded",
            label: history.pushOnly
              ? "Update processed with issues"
              : "Latest sync completed with issues",
            accessibilityLabel: history.pushOnly
              ? "Update processed with issues"
              : "Sync completed with issues",
          }
        : null;
  const attemptedAt = latestIssue ? (latestLog?.syncedAt ?? null) : history.lastSyncAt;

  return {
    lastAttemptAt:
      history.pushOnly || (attemptedAt === lastSuccessfulAt && !latestIssue) ? null : attemptedAt,
    lastSuccessfulSyncAt: lastSuccessfulAt,
    latestIssue,
    hasHistory:
      (!history.pushOnly && history.lastSyncAt !== null) ||
      lastSuccessfulAt !== null ||
      latestLog !== null,
  };
}
