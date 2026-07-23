import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingHeading,
  processingStageLabel,
  processingStatusMessage,
} from "@dofek/providers/processing-status";
import { useState } from "react";

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

const borderClassByStatus: Record<ProcessingDisplayStatus, string> = {
  ready: "border-l-emerald-500",
  waiting: "border-l-blue-500",
  active: "border-l-blue-500",
  partial: "border-l-blue-500",
  delayed: "border-l-amber-500",
  blocked: "border-l-red-500",
  failed: "border-l-red-500",
  cancelled: "border-l-slate-400",
};

function statusLabel(status: string): string {
  if (status === "succeeded") return "Completed";
  if (status === "running") return "In progress";
  if (status === "queued") return "Waiting";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Skipped";
}

export function ProcessingStatusWidget({
  data,
  error = null,
  loading = false,
  contextLabel,
  alwaysVisible = false,
}: ProcessingStatusWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  if (loading && !data) return null;
  if (error) {
    return (
      <output className="block w-full rounded-lg border border-l-4 border-l-red-500 bg-white px-3 py-2.5 text-slate-950 shadow-sm">
        <h2 className="text-sm font-semibold">Processing status is unavailable</h2>
        <p className="mt-0.5 text-xs text-slate-600">{error.message}</p>
      </output>
    );
  }
  if (!data || (data.overallStatus === "ready" && !alwaysVisible)) return null;

  const latestFailure = data.operations
    .flatMap((operation) => operation.timeline)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .find((event) => event.status === "failed")?.errorMessage;
  const progressValues = data.datasets.flatMap((dataset) =>
    dataset.progressPercentage === null ? [] : [dataset.progressPercentage],
  );
  const progress = progressValues.length > 0 ? Math.min(...progressValues) : null;

  return (
    <output
      className={`block w-full rounded-lg border border-l-4 bg-white px-3 py-2.5 text-slate-950 shadow-sm ${borderClassByStatus[data.overallStatus]}`}
      aria-live={
        data.overallStatus === "active" || data.overallStatus === "partial" ? "polite" : undefined
      }
    >
      {contextLabel ? (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {contextLabel}
        </p>
      ) : null}
      <h2 className="text-sm font-semibold">{processingHeading(data.overallStatus)}</h2>
      <p className="mt-0.5 text-xs text-slate-600">
        {processingStatusMessage({
          status: data.overallStatus,
          errorMessage: latestFailure ?? null,
        })}
      </p>
      {progress !== null && data.overallStatus !== "ready" ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-label="Processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full bg-blue-500" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {data.operations.length > 0 ? (
        <button
          type="button"
          className="mt-2 text-xs font-semibold text-blue-700"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide processing details" : "Show processing details"}
        </button>
      ) : null}
      {expanded ? (
        <ol className="mt-2 space-y-2 border-l border-slate-200 pl-3">
          {data.operations.flatMap((operation) =>
            operation.timeline.map((event) => (
              <li
                key={`${operation.id}-${event.stage}-${event.datasetKey ?? "all"}-${event.outputPath ?? "dataset"}-${event.occurredAt}`}
              >
                <p className="text-xs font-semibold">{processingStageLabel(event.stage)}</p>
                <p className="text-xs text-slate-600">
                  {statusLabel(event.status)} · {new Date(event.occurredAt).toLocaleString()}
                </p>
              </li>
            )),
          )}
        </ol>
      ) : null}
    </output>
  );
}
