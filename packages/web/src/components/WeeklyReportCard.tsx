import type { WeeklyReportResult, WeekSummary } from "dofek-server/types";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface WeeklyReportCardProps {
  data: WeeklyReportResult | undefined;
  loading?: boolean;
}

function strainZoneColor(zone: WeekSummary["strainZone"]): string {
  if (zone === "restoring") return "#3b82f6";
  if (zone === "optimal") return "#22c55e";
  return "#ef4444";
}

function strainZoneLabel(zone: WeekSummary["strainZone"]): string {
  if (zone === "restoring") return "Restoring";
  if (zone === "optimal") return "Optimal";
  return "Overreaching";
}

function sleepPerfColor(percentage: number): string {
  if (percentage >= 95) return "#22c55e";
  if (percentage >= 85) return "#eab308";
  return "#ef4444";
}

function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

export function WeeklyReportCard({ data, loading }: WeeklyReportCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={320} />;
  }

  if (!data?.current) {
    return (
      <div className="card p-6 flex items-center justify-center h-[320px]">
        <span className="text-dim text-sm">No weekly data yet</span>
      </div>
    );
  }

  const { current, history } = data;
  const zoneColor = strainZoneColor(current.strainZone);
  const prevWeek = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-muted text-sm font-medium mb-1">Weekly Performance</h3>
          <p className="text-dim text-xs">
            Week of{" "}
            {new Date(current.weekStart).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
        <div
          className="px-3 py-1 rounded-full text-xs font-semibold"
          style={{ backgroundColor: `${zoneColor}20`, color: zoneColor }}
        >
          {strainZoneLabel(current.strainZone)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        <StatBlock
          label="Training"
          value={`${current.trainingHours}h`}
          sub={`${current.activityCount} activities`}
          prevValue={prevWeek ? `${prevWeek.trainingHours}h` : undefined}
        />
        <StatBlock
          label="Sleep"
          value={formatHoursMinutes(current.avgSleepMinutes)}
          sub={
            <span style={{ color: sleepPerfColor(current.sleepPerformancePct) }}>
              {current.sleepPerformancePct}% of avg
            </span>
          }
          prevValue={prevWeek ? formatHoursMinutes(prevWeek.avgSleepMinutes) : undefined}
        />
        <StatBlock
          label="Resting HR"
          value={current.avgRestingHr != null ? `${current.avgRestingHr}` : "—"}
          sub="bpm avg"
        />
        <StatBlock
          label="HRV"
          value={current.avgHrv != null ? `${current.avgHrv}` : "—"}
          sub="ms avg"
        />
      </div>

      {/* Strain zone history mini bar */}
      {history.length > 0 && (
        <div>
          <p className="text-subtle text-xs mb-2">Recent weeks</p>
          <div className="flex gap-1">
            {history.slice(-8).map((w) => (
              <div
                key={w.weekStart}
                className="flex-1 h-2 rounded-full"
                style={{ backgroundColor: strainZoneColor(w.strainZone) }}
                title={`${w.weekStart}: ${strainZoneLabel(w.strainZone)}`}
              />
            ))}
            <div
              className="flex-1 h-2 rounded-full ring-2 ring-border-strong"
              style={{ backgroundColor: zoneColor }}
              title="This week"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatBlock({
  label,
  value,
  sub,
  prevValue,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  prevValue?: string;
}) {
  return (
    <div>
      <p className="text-subtle text-xs mb-1">{label}</p>
      <p className="text-foreground text-lg font-semibold tabular-nums">{value}</p>
      <div className="text-subtle text-xs">
        {sub}
        {prevValue && <span className="ml-1 text-dim">(prev: {prevValue})</span>}
      </div>
    </div>
  );
}
