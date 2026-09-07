import { formatRelativeTime } from "@dofek/format/format";
import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingDatasetStatusLabel,
  processingFailureGroups,
  processingHeading,
  processingStatusMessage,
  processingTarget,
} from "@dofek/providers/processing-status";
import { Link } from "@tanstack/react-router";
import { trpc } from "../lib/trpc.ts";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator.tsx";
import { SourceProcessingStatusCard } from "./SourceProcessingStatusCard.tsx";

export interface ProcessingStatusSnapshot {
  generatedAt: string;
  scope: { providerId: string | null; datasets: string[] };
  overallStatus: ProcessingDisplayStatus;
  datasets: Array<{
    key: string;
    label: string;
    status: ProcessingDisplayStatus;
    currentStage: ProcessingDisplayStage | null;
    progressPercentage: number | null;
    lastAdvancedAt: string | null;
    lastReadyAt: string | null;
    lastFailedAt: string | null;
  }>;
  operations: Array<{
    id: string;
    providerId: string | null;
    kind: string;
    createdAt: string;
    status: ProcessingDisplayStatus;
    datasets: string[];
    dismissed: boolean;
    errorMessage: string | null;
    errorCode?: string | null;
    timeline: Array<{
      sequence: number;
      stage: ProcessingDisplayStage;
      status: string;
      datasetKey: string | null;
      outputPath: "relational" | "metric_stream" | null;
      occurredAt: string;
      progressPercentage: number | null;
      message: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  }>;
}

interface ProcessingStatusWidgetProps {
  data?: ProcessingStatusSnapshot;
  error?: { message: string } | null;
  loading?: boolean;
  contextLabel?: string;
  alwaysVisible?: boolean;
}

export function ProcessingStatusWidget({
  data,
  error = null,
  loading = false,
  contextLabel,
  alwaysVisible = false,
}: ProcessingStatusWidgetProps) {
  const trpcUtils = trpc.useUtils();
  const dismissMutation = trpc.processing.dismiss.useMutation({
    onSuccess: async () => {
      await trpcUtils.processing.status.invalidate();
      await trpcUtils.processing.alerts.invalidate();
    },
  });
  if (loading && !data) {
    return (
      <section
        className="w-full rounded-lg border border-l-4 border-l-blue-500 bg-surface-solid px-3 py-2.5 text-foreground shadow-sm"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="text-sm font-semibold">Loading processing status…</p>
      </section>
    );
  }
  if (error && !data) {
    return (
      <SourceProcessingStatusCard
        heading="Processing status is unavailable"
        message={error.message}
        progress={null}
        status="failed"
      />
    );
  }
  if (!data || (data.overallStatus === "ready" && !alwaysVisible)) {
    return null;
  }

  const progress = processingAggregateProgress(data.datasets);
  const target = processingTarget({
    providerId: data.scope.providerId,
    datasets: data.datasets,
    operationKind: data.operations[0]?.kind,
  });
  const problemDatasets = data.datasets.filter(
    (dataset) => dataset.status === "failed" || dataset.status === "blocked",
  );
  const failureGroups = processingFailureGroups({
    datasets: data.datasets,
    operations: data.operations,
  });
  const statusMessage =
    failureGroups.length > 0
      ? null
      : processingStatusMessage({
          status: data.overallStatus,
          errorMessage: null,
        });
  const hasFailureStatus = data.overallStatus === "failed" || data.overallStatus === "blocked";
  const inProgressDatasets = data.datasets.filter((dataset) =>
    ["active", "partial", "waiting", "delayed"].includes(dataset.status),
  );
  if (hasFailureStatus && failureGroups.length === 0 && inProgressDatasets.length === 0) {
    return null;
  }
  const displayStatus =
    hasFailureStatus && failureGroups.length === 0
      ? (inProgressDatasets[0]?.status ?? data.overallStatus)
      : data.overallStatus;
  const heading = processingHeading(displayStatus, target);
  const datasetsWithHistory = data.datasets.filter(
    (dataset) =>
      dataset.status !== "ready" || dataset.lastAdvancedAt !== null || dataset.lastReadyAt !== null,
  );
  const visibleDatasets = alwaysVisible
    ? datasetsWithHistory
    : failureGroups.length > 0
      ? problemDatasets
      : inProgressDatasets;
  const historicalDatasetDetails =
    visibleDatasets.length > 0 ? (
      <ul className="mt-2 divide-y divide-border border-t border-border">
        {visibleDatasets.map((dataset) => {
          const lastReady = dataset.lastReadyAt ? formatRelativeTime(dataset.lastReadyAt) : null;
          return (
            <li key={dataset.key} className="py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-foreground">{dataset.label}</span>
                <span className="text-muted">{processingDatasetStatusLabel(dataset.status)}</span>
              </div>
              <p className="mt-0.5 text-subtle">
                {lastReady ? `Last ready: ${lastReady}` : "No completed update recorded"}
              </p>
            </li>
          );
        })}
      </ul>
    ) : null;
  const failureGroupDetails =
    failureGroups.length > 0 ? (
      <ul className="mt-2 divide-y divide-border border-t border-border">
        {failureGroups.map((group) => {
          const failedAt = group.failedAt ? formatRelativeTime(group.failedAt) : null;
          const lastReadyAt = group.lastReadyAt ? formatRelativeTime(group.lastReadyAt) : null;
          const labelPrefix = group.providerLabel ? `${group.providerLabel} sync` : "data update";
          return (
            <li key={group.operationId} className="py-2 text-xs">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <ul className="flex flex-wrap gap-x-2 gap-y-1 font-semibold text-foreground">
                    {group.datasetLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                  <p className="mt-0.5 text-subtle">
                    {processingDatasetStatusLabel(group.status)}: {failedAt ?? "not recorded"}
                  </p>
                  {lastReadyAt ? (
                    <p className="mt-0.5 text-subtle">Last successful update: {lastReadyAt}</p>
                  ) : null}
                  {group.errorMessage ? (
                    <p className="mt-1 text-red-700">{group.errorMessage}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {group.requiresReconnect && group.providerId && group.providerLabel ? (
                    <Link
                      className="inline-flex items-center justify-center rounded-md bg-accent px-2 py-1 text-xs font-semibold text-on-accent transition-colors hover:bg-accent/90"
                      to="/providers/$id"
                      params={{ id: group.providerId }}
                    >
                      Reconnect {group.providerLabel}
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50"
                    disabled={dismissMutation.isPending}
                    aria-label={`Dismiss ${labelPrefix} failure`}
                    onClick={() => dismissMutation.mutate({ operationId: group.operationId })}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    ) : null;
  const datasetDetails = failureGroupDetails ?? historicalDatasetDetails;

  if (target.action === "recompute" && failureGroups.length === 0) {
    return <RecomputeStatusIndicator label={heading} progress={progress} status={displayStatus} />;
  }

  return (
    <SourceProcessingStatusCard
      contextLabel={contextLabel}
      heading={heading}
      message={statusMessage}
      progress={progress}
      status={displayStatus}
    >
      {datasetDetails}
      {dismissMutation.error ? (
        <p className="mt-2 text-xs font-medium text-red-700" role="alert">
          {dismissMutation.error.message}
        </p>
      ) : null}
    </SourceProcessingStatusCard>
  );
}
