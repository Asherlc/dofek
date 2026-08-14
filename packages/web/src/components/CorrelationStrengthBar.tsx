import { formatSigned } from "@dofek/format/format";
import { chartColors } from "@dofek/scoring/colors";

interface CorrelationStrengthBarProps {
  rho: number;
}

export function CorrelationStrengthBar({ rho }: CorrelationStrengthBarProps) {
  const clampedRho = Math.max(-1, Math.min(1, rho));
  const percentage = Math.abs(clampedRho) * 50;
  const isPositive = clampedRho >= 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3 flex-1 rounded-full bg-accent/10 overflow-hidden">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-strong" />
        {/* Fill bar */}
        <div
          data-testid="correlation-fill"
          className="absolute top-0 bottom-0"
          style={
            isPositive
              ? { backgroundColor: chartColors.blue, left: "50%", width: `${percentage}%` }
              : { backgroundColor: chartColors.blue, right: "50%", width: `${percentage}%` }
          }
        />
      </div>
      <span className="text-xs font-mono tabular-nums w-12 text-right text-muted">
        {formatSigned(clampedRho, 2)}
      </span>
    </div>
  );
}
