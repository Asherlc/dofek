import type { ProcessingDisplayStatus } from "@dofek/providers/processing-status";
import { operationalStatusColors } from "@dofek/scoring/colors";
import { type ReactNode, useId, useState } from "react";

interface SourceProcessingStatusCardProps {
  contextLabel?: string;
  heading: string;
  message: string | null;
  progress: number | null;
  status: ProcessingDisplayStatus;
  tone?: "success" | "warning" | "danger" | "neutral";
  children?: ReactNode;
  details?: ReactNode;
}

const indicatorColorByStatus: Record<ProcessingDisplayStatus, string> = {
  ready: operationalStatusColors.success.indicator,
  waiting: operationalStatusColors.info.indicator,
  active: operationalStatusColors.info.indicator,
  partial: operationalStatusColors.info.indicator,
  delayed: operationalStatusColors.warning.indicator,
  blocked: operationalStatusColors.warning.indicator,
  failed: operationalStatusColors.danger.indicator,
  cancelled: operationalStatusColors.neutral.indicator,
};

export function SourceProcessingStatusCard({
  contextLabel,
  heading,
  message,
  progress,
  status,
  tone,
  children,
  details,
}: SourceProcessingStatusCardProps) {
  const detailsId = useId();
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  return (
    <section
      className="w-full rounded-lg border border-l-4 bg-surface-solid px-3 py-2.5 text-foreground shadow-sm"
      style={{
        borderLeftColor: tone
          ? operationalStatusColors[tone].indicator
          : indicatorColorByStatus[status],
      }}
      aria-live="polite"
    >
      {contextLabel ? (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          {contextLabel}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-sm font-semibold">{heading}</h2>
        {details ? (
          <button
            type="button"
            className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded px-1 text-xs text-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label={detailsExpanded ? "Hide processing details" : "Show processing details"}
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            onClick={() => setDetailsExpanded((expanded) => !expanded)}
          >
            Details <span aria-hidden="true">{detailsExpanded ? "▾" : "▸"}</span>
          </button>
        ) : null}
      </div>
      {message ? <p className="mt-0.5 text-xs text-muted">{message}</p> : null}
      {children}
      {details ? <div id={detailsId}>{detailsExpanded ? details : null}</div> : null}
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
