import type { ReactNode } from "react";

export type TrainingProgressionStatus = "ready" | "stagnating" | null;

export function trainingProgressionStatusLabel(status: TrainingProgressionStatus): string | null {
  if (status === "ready") return "Ready to progress";
  if (status === "stagnating") return "Stagnating";
  return null;
}

/**
 * Read-only status and evidence block shared by the Home summary, Strength
 * evidence, and cycling Activity Detail. The server owns the status; this
 * component only formats and discloses what it is given.
 */
export function TrainingProgressionStatusCard({
  status,
  headline,
  summary,
  details,
  action,
}: {
  status: TrainingProgressionStatus;
  headline: string;
  summary: string;
  details?: ReactNode;
  action?: ReactNode;
}) {
  const label = trainingProgressionStatusLabel(status);
  return (
    <section
      aria-label="Training progression status"
      className="rounded-lg bg-surface p-3 space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{headline}</h3>
        {label ? (
          <span className="rounded border border-border px-2 py-0.5 text-xs text-accent">
            {label}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted">{summary}</p>
      {details}
      {action}
    </section>
  );
}
