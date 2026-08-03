import { formatRelativeTime } from "@dofek/format/format";
import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingDatasetErrorMessage,
  processingDatasetStatusLabel,
  processingHeading,
  processingStatusMessage,
  processingTarget,
} from "@dofek/providers/processing-status";
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
  }>;
  operations: Array<{
    id: string;
    providerId: string | null;
    kind: string;
    createdAt: string;
    status: ProcessingDisplayStatus;
    datasets: string[];
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
  const statusMessage = processingStatusMessage({
    status: data.overallStatus,
    errorMessage: null,
  });
  const heading = processingHeading(data.overallStatus, target);
  const problemDatasets = data.datasets.filter(
    (dataset) => dataset.status === "failed" || dataset.status === "blocked",
  );
  const datasetsWithHistory = data.datasets.filter(
    (dataset) =>
      dataset.status !== "ready" || dataset.lastAdvancedAt !== null || dataset.lastReadyAt !== null,
  );
  const visibleDatasets = alwaysVisible ? datasetsWithHistory : problemDatasets;
  const datasetDetails =
    visibleDatasets.length > 0 ? (
      <ul className="mt-2 divide-y divide-border border-t border-border">
        {visibleDatasets.map((dataset) => {
          const lastReady = dataset.lastReadyAt ? formatRelativeTime(dataset.lastReadyAt) : null;
          const datasetError =
            dataset.status === "failed" || dataset.status === "blocked"
              ? processingDatasetErrorMessage(data.operations, dataset.key)
              : null;
          return (
            <li key={dataset.key} className="py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-foreground">{dataset.label}</span>
                <span className="text-muted">{processingDatasetStatusLabel(dataset.status)}</span>
              </div>
              <p className="mt-0.5 text-subtle">
                {lastReady ? `Last ready: ${lastReady}` : "No completed update recorded"}
              </p>
              {datasetError ? <p className="mt-1 text-red-700">{datasetError}</p> : null}
            </li>
          );
        })}
      </ul>
    ) : null;

  if (target.action === "recompute" && visibleDatasets.length === 0) {
    return (
      <RecomputeStatusIndicator label={heading} progress={progress} status={data.overallStatus} />
    );
  }

  return (
    <SourceProcessingStatusCard
      contextLabel={contextLabel}
      heading={heading}
      message={statusMessage}
      progress={progress}
      status={data.overallStatus}
    >
      {datasetDetails}
    </SourceProcessingStatusCard>
  );
}
