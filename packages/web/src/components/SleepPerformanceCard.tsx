import type { SleepPerformanceInfo } from "dofek-server/types";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

const tierColors: Record<string, string> = {
  Excellent: "#22c55e",
  Good: "#3b82f6",
  Fair: "#eab308",
  Poor: "#ef4444",
};

interface SleepPerformanceCardProps {
  data: SleepPerformanceInfo | null | undefined;
  loading?: boolean;
}

export function SleepPerformanceCard({ data, loading }: SleepPerformanceCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={140} />;
  }

  if (!data) {
    return (
      <div className="card p-6 flex items-center justify-center h-[140px]">
        <span className="text-dim text-sm">No sleep data yet</span>
      </div>
    );
  }

  const color = tierColors[data.tier] ?? "#6b7280";
  const hours = Math.floor(data.actualMinutes / 60);
  const mins = Math.round(data.actualMinutes % 60);

  return (
    <div className="card p-6">
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-center">
          <div className="text-4xl font-bold font-mono tabular-nums" style={{ color }}>
            {data.score}
            <span className="text-lg">%</span>
          </div>
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full mt-1"
            style={{ backgroundColor: `${color}20`, color }}
          >
            {data.tier}
          </span>
        </div>

        <div className="flex-1 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-subtle">Slept</p>
              <p className="text-foreground font-medium">
                {hours}h {mins}m
              </p>
            </div>
            <div>
              <p className="text-subtle">Efficiency</p>
              <p className="text-foreground font-medium">{Math.round(data.efficiency)}%</p>
            </div>
          </div>
          <div className="pt-1 border-t border-border">
            <p className="text-xs text-subtle">
              Recommended bedtime:{" "}
              <span className="text-foreground font-medium">{data.recommendedBedtime}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
