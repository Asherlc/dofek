import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";
import { operationalStatusColors } from "@dofek/scoring/colors";
import type { ReactNode } from "react";

interface SourceProcessingStatusCardProps {
  contextLabel?: string;
  heading: string;
  message: string | null;
  progress: number | null;
  status: ProcessingDisplayStatus;
  children?: ReactNode;
}

const indicatorColorByStatus: Record<ProcessingDisplayStatus, string> = {
  ready: operationalStatusColors.success.indicator,
  waiting: operationalStatusColors.info.indicator,
  active: operationalStatusColors.info.indicator,
  partial: operationalStatusColors.info.indicator,
  delayed: operationalStatusColors.warning.indicator,
  blocked: operationalStatusColors.danger.indicator,
  failed: operationalStatusColors.danger.indicator,
  cancelled: operationalStatusColors.neutral.indicator,
};

export function SourceProcessingStatusCard({
  contextLabel,
  heading,
  message,
  progress,
  status,
  children,
}: SourceProcessingStatusCardProps) {
  return (
    <section
      className="w-full rounded-lg border border-l-4 bg-surface-solid px-3 py-2.5 text-foreground shadow-sm"
      style={{ borderLeftColor: indicatorColorByStatus[status] }}
      aria-live="polite"
    >
      {contextLabel ? (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          {contextLabel}
        </p>
      ) : null}
      <h2 className="text-sm font-semibold">{heading}</h2>
      {message ? <p className="mt-0.5 text-xs text-muted">{message}</p> : null}
      {children}
      {progress !== null && status !== "ready" ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-skeleton"
          role="progressbar"
          aria-label="Processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full"
            style={{
              backgroundColor: operationalStatusColors.info.indicator,
              width: `${progress}%`,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
