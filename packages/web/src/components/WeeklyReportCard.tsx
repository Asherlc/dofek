import { StrainZone, sleepPerformanceColor } from "@dofek/scoring/scoring";
import type { WeeklyReportResult } from "dofek-server/types";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface WeeklyReportCardProps {
  data: WeeklyReportResult | undefined;
  loading?: boolean;
}

function formatHoursMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return `${hours}h ${remainingMinutes}m`;
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
  const currentZone = new StrainZone(current.strainZone);
  const zoneColor = currentZone.color;
  const sleepWasTracked = current.avgSleepMinutes > 0;
  const prevWeek = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-muted text-sm font-medium mb-1">Weekly Performance</h3>
          <p className="text-dim text-xs">
            Week of{" "}
            {new Date(`${current.weekStart}T12:00:00`).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
        {sleepWasTracked ? (
          <div
            className="px-3 py-1 rounded-full text-xs font-semibold"
            style={{ backgroundColor: `${zoneColor}20`, color: zoneColor }}
          >
            {currentZone.label}
          </div>
        ) : (
          <div className="px-3 py-1 rounded-full text-xs font-semibold bg-surface-hover text-subtle">
            Sleep not tracked
          </div>
        )}
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
          value={sleepWasTracked ? formatHoursMinutes(current.avgSleepMinutes) : "Not tracked"}
          sub={
            sleepWasTracked ? (
              <span style={{ color: sleepPerformanceColor(current.sleepPerformancePct) }}>
                {current.sleepPerformancePct}% of avg
              </span>
            ) : (
              "Track sleep to compare weeks"
            )
          }
          prevValue={
            prevWeek && prevWeek.avgSleepMinutes > 0
              ? formatHoursMinutes(prevWeek.avgSleepMinutes)
              : undefined
          }
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
            {history.slice(-8).map((w) => {
              const zone = new StrainZone(w.strainZone);
              const weekHasSleepData = w.avgSleepMinutes > 0;
              return (
                <div
                  key={w.weekStart}
                  className={`flex-1 h-2 rounded-full ${weekHasSleepData ? "" : "bg-surface-hover"}`}
                  style={weekHasSleepData ? { backgroundColor: zone.color } : undefined}
                  title={`${w.weekStart}: ${weekHasSleepData ? zone.label : "Sleep not tracked"}`}
                />
              );
            })}
            {sleepWasTracked ? (
              <div
                className="flex-1 h-2 rounded-full ring-2 ring-border-strong"
                style={{ backgroundColor: zoneColor }}
                title="This week"
              />
            ) : (
              <div
                className="flex-1 h-2 rounded-full ring-2 ring-border-strong bg-surface-hover"
                title="This week: Sleep not tracked"
              />
            )}
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
