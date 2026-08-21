import { formatDurationMinutes, formatIntensity } from "@dofek/format/format";
import { sleepTierColor } from "@dofek/scoring/scoring";
import type { SleepPerformanceInfo } from "dofek-server/types";
import { useFetchingCount } from "../lib/FetchingContext.tsx";
import { formatSleepProvenance } from "../lib/sleepSource.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SleepPerformanceCardProps {
  data: SleepPerformanceInfo | null | undefined;
  loading?: boolean;
}

export function SleepPerformanceCard({ data, loading }: SleepPerformanceCardProps) {
  const fetchingCount = useFetchingCount();

  if (loading) {
    return <ChartLoadingSkeleton height={140} />;
  }

  if (!data) {
    if (fetchingCount > 0) {
      return <ChartLoadingSkeleton height={140} />;
    }
    return (
      <div className="card p-6 flex items-center justify-center h-[140px]">
        <span className="text-dim text-sm">No sleep data yet</span>
      </div>
    );
  }

  const color = sleepTierColor(data.tier);
  const { primary, alsoFrom } = formatSleepProvenance(data);
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
                {formatDurationMinutes(data.actualMinutes)}
              </p>
            </div>
            <div>
              <p className="text-subtle">Efficiency</p>
              <p className="text-foreground font-medium">{formatIntensity(data.efficiency)}</p>
            </div>
          </div>
          <div className="pt-1 border-t border-border space-y-1">
            <p className="text-xs text-subtle">
              Recommended bedtime:{" "}
              <span className="text-foreground font-medium">{data.recommendedBedtime}</span>
            </p>
            <p className="text-xs text-subtle">
              Data from <span className="text-foreground font-medium">{primary}</span>
              {alsoFrom ? ` · also reported by ${alsoFrom}` : ""}
            </p>
          </div>
        </div>
      </div>
      <a
        aria-label="View sleep source data"
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent transition-colors hover:text-accent-secondary"
        href="#sleep-data-sources"
      >
        View data <span aria-hidden>→</span>
      </a>
    </div>
  );
}
