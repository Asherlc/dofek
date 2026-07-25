import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";

interface RecomputeStatusIndicatorProps {
  label: string;
  progress: number | null;
  status: ProcessingDisplayStatus;
}

const ringClassByStatus: Record<ProcessingDisplayStatus, string> = {
  ready: "text-emerald-500",
  waiting: "text-blue-500",
  active: "text-blue-500",
  partial: "text-blue-500",
  delayed: "text-amber-500",
  blocked: "text-red-500",
  failed: "text-red-500",
  cancelled: "text-slate-400",
};

export function RecomputeStatusIndicator({
  label,
  progress,
  status,
}: RecomputeStatusIndicatorProps) {
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const clampedProgress = progress === null ? null : Math.min(100, Math.max(0, progress));

  return (
    <div className="inline-flex items-center gap-2 text-xs font-medium text-muted">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        className={ringClassByStatus[status]}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clampedProgress ?? undefined}
      >
        <title>{label}</title>
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          opacity="0.2"
        />
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={
            clampedProgress === null ? `${circumference * 0.25} ${circumference}` : circumference
          }
          strokeDashoffset={
            clampedProgress === null ? 0 : circumference * (1 - clampedProgress / 100)
          }
          transform="rotate(-90 16 16)"
          className={clampedProgress === null ? "origin-center animate-spin" : undefined}
        />
      </svg>
      <span>{label}</span>
    </div>
  );
}
