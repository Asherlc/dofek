import {
  type ProcessingDisplayStage,
  type ProcessingDisplayStatus,
  processingAggregateProgress,
  processingCurrentFailure,
  processingHeading,
  processingStatusMessage,
} from "@dofek/providers/processing-status";

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
        className="w-full rounded-lg border border-l-4 border-l-blue-500 bg-white px-3 py-2.5 text-slate-950 shadow-sm"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="text-sm font-semibold">Loading processing status…</p>
      </section>
    );
  }
  if (error && !data) {
    return (
      <section
        className="w-full rounded-lg border border-l-4 border-l-red-500 bg-white px-3 py-2.5 text-slate-950 shadow-sm"
        aria-live="polite"
      >
        <h2 className="text-sm font-semibold">Processing status is unavailable</h2>
        <p className="mt-0.5 text-xs text-slate-600">{error.message}</p>
      </section>
    );
  }
  if (!data || (data.overallStatus === "ready" && !alwaysVisible)) return null;

  const currentFailure = processingCurrentFailure(data);
  const progress = processingAggregateProgress(data.datasets);

  return (
    <section
      className={`w-full rounded-lg border border-l-4 bg-white px-3 py-2.5 text-slate-950 shadow-sm ${borderClassByStatus[data.overallStatus]}`}
      aria-live="polite"
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
          errorMessage: currentFailure,
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
    </section>
  );
}
