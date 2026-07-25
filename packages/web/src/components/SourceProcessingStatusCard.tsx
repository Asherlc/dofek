import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";

interface SourceProcessingStatusCardProps {
  contextLabel?: string;
  heading: string;
  message: string | null;
  progress: number | null;
  status: ProcessingDisplayStatus;
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

export function SourceProcessingStatusCard({
  contextLabel,
  heading,
  message,
  progress,
  status,
}: SourceProcessingStatusCardProps) {
  return (
    <section
      className={`w-full rounded-lg border border-l-4 bg-white px-3 py-2.5 text-slate-950 shadow-sm ${borderClassByStatus[status]}`}
      aria-live="polite"
    >
      {contextLabel ? (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {contextLabel}
        </p>
      ) : null}
      <h2 className="text-sm font-semibold">{heading}</h2>
      {message ? <p className="mt-0.5 text-xs text-slate-600">{message}</p> : null}
      {progress !== null && status !== "ready" ? (
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
