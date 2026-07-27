import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";
import { operationalStatusColors } from "@dofek/scoring/colors";
import { ClipLoader } from "react-spinners";

interface RecomputeStatusIndicatorProps {
  label: string;
  progress: number | null;
  status: ProcessingDisplayStatus;
}

const ringColorByStatus: Record<ProcessingDisplayStatus, string> = {
  ready: operationalStatusColors.success.indicator,
  waiting: operationalStatusColors.info.indicator,
  active: operationalStatusColors.info.indicator,
  partial: operationalStatusColors.info.indicator,
  delayed: operationalStatusColors.warning.indicator,
  blocked: operationalStatusColors.danger.indicator,
  failed: operationalStatusColors.danger.indicator,
  cancelled: operationalStatusColors.neutral.indicator,
};

export function RecomputeStatusIndicator({
  label,
  progress,
  status,
}: RecomputeStatusIndicatorProps) {
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  const clampedProgress = progress === null ? null : Math.min(100, Math.max(0, progress));
  const ringColor = ringColorByStatus[status];

  return (
    <div className="flex w-full min-w-0 items-center gap-2 text-xs font-medium text-muted">
      {clampedProgress === null ? (
        <ClipLoader
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          className="shrink-0"
          color="currentColor"
          data-testid="recompute-spinner"
          role="progressbar"
          size={32}
          style={{ color: ringColor }}
        />
      ) : (
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          className="shrink-0"
          style={{ color: ringColor }}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedProgress}
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
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clampedProgress / 100)}
            transform="rotate(-90 16 16)"
          />
        </svg>
      )}
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
}
