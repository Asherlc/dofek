import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
export interface OperationProgressBarProps {
  message?: string;
  percentage?: number;
}

export interface OperationProgressItem extends OperationProgressBarProps {
  id: string;
  label: string;
}

function clampPercentage(percentage: number): number {
  return Math.max(0, Math.min(100, percentage));
}

export function OperationProgressBar({ message, percentage }: OperationProgressBarProps) {
  const boundedPercentage = percentage === undefined ? undefined : clampPercentage(percentage);
  const displayMessage = message ? userFacingErrorMessage(message) : undefined;

  return (
    <div className="space-y-1">
      <div
        aria-label={displayMessage ?? "Operation progress"}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={boundedPercentage}
        className="h-1.5 w-full overflow-hidden rounded-full bg-accent/10"
        role="progressbar"
      >
        <div
          className={`h-full rounded-full bg-emerald-500 transition-all duration-300 ${
            boundedPercentage === undefined ? "animate-pulse" : ""
          }`}
          data-testid="operation-progress-fill"
          style={{ width: `${boundedPercentage ?? 35}%` }}
        />
      </div>
      {displayMessage && <span className="block text-xs text-subtle">{displayMessage}</span>}
    </div>
  );
}

export function OperationProgressBars({
  operations,
}: {
  operations: readonly OperationProgressItem[];
}) {
  return (
    <div className="space-y-3">
      {operations.map((operation) => (
        <div className="space-y-1" key={operation.id}>
          <span className="block text-xs font-medium text-foreground">{operation.label}</span>
          <OperationProgressBar message={operation.message} percentage={operation.percentage} />
        </div>
      ))}
    </div>
  );
}
