import { formatSigned } from "../lib/format.ts";

interface CorrelationStrengthBarProps {
  rho: number;
}

export function CorrelationStrengthBar({ rho }: CorrelationStrengthBarProps) {
  const clampedRho = Math.max(-1, Math.min(1, rho));
  const percentage = Math.abs(clampedRho) * 50;
  const isPositive = clampedRho >= 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3 flex-1 rounded-full bg-zinc-800 overflow-hidden">
        {/* Center line */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-600" />
        {/* Fill bar */}
        <div
          className={`absolute top-0 bottom-0 ${isPositive ? "bg-emerald-500/70" : "bg-rose-500/70"}`}
          style={
            isPositive
              ? { left: "50%", width: `${percentage}%` }
              : { right: "50%", width: `${percentage}%` }
          }
        />
      </div>
      <span
        className={`text-xs font-mono tabular-nums w-12 text-right ${
          isPositive ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {formatSigned(clampedRho, 2)}
      </span>
    </div>
  );
}
