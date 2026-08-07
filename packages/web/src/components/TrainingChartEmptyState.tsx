import type { TrainingChartAvailability } from "dofek-server/types";

interface TrainingChartEmptyStateProps {
  availability: TrainingChartAvailability;
}

export function TrainingChartEmptyState({ availability }: TrainingChartEmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 py-3 text-center"
      data-testid="training-chart-empty-state"
    >
      <p className="text-sm text-subtle">{availability.message}</p>
      <p className="text-xs text-dim">
        {availability.observedCount} of {availability.minimumCount} required observations ·{" "}
        {availability.sourceLabel}
      </p>
    </div>
  );
}
