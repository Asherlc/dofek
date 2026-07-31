import { formatDateShort, formatDurationMinutes, formatHRV } from "@dofek/format/format";
import { sleepPerformanceColor } from "@dofek/scoring/scoring";
import type { WeeklyReportData } from "dofek-server/types";
import { EmptyStatePreview } from "./EmptyStatePreview.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";
import { ReportDecisionSynthesis } from "./ReportDecisionSynthesis.tsx";

interface WeeklyReportCardProps {
  data: WeeklyReportData | undefined;
  loading?: boolean;
}

export function WeeklyReportCard({ data, loading }: WeeklyReportCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={320} />;
  }

  if (!data) {
    return (
      <div className="card p-6 flex items-center justify-center h-[320px]">
        <span className="text-dim text-sm">No weekly data yet</span>
      </div>
    );
  }

  if (!data.current) {
    return <EmptyStatePreview content={data.emptyState} />;
  }

  const { current, history } = data;
  const sleepWasTracked = current.avgSleepMinutes > 0;
  const hasTraining = current.activityCount > 0 || current.trainingHours > 0;
  const prevWeek = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="space-y-4">
      {data.decisionSupport && <ReportDecisionSynthesis synthesis={data.decisionSupport} />}
      <div className="card p-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-muted text-sm font-medium mb-1">Weekly Performance</h3>
            <p className="text-dim text-xs">Week of {formatDateShort(current.weekStart)}</p>
          </div>
          {!sleepWasTracked ? (
            <div className="px-3 py-1 rounded-full text-xs font-semibold bg-surface-hover text-subtle">
              Sleep not tracked
            </div>
          ) : !hasTraining ? (
            <div className="px-3 py-1 rounded-full text-xs font-semibold bg-surface-hover text-subtle">
              No training
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <StatBlock
            label="Training"
            value={formatDurationMinutes(current.trainingHours * 60)}
            sub={`${current.activityCount} activities`}
            prevValue={prevWeek ? formatDurationMinutes(prevWeek.trainingHours * 60) : undefined}
          />
          <StatBlock
            label="Avg nightly sleep"
            value={sleepWasTracked ? formatDurationMinutes(current.avgSleepMinutes) : "Not tracked"}
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
                ? formatDurationMinutes(prevWeek.avgSleepMinutes)
                : undefined
            }
          />
          <StatBlock
            label="Resting HR"
            value={current.avgRestingHr != null ? `${current.avgRestingHr}` : "—"}
            sub="bpm avg"
          />
          <StatBlock
            label="Heart Rate Variability (HRV)"
            value={formatHRV(current.avgHrv)}
            sub="avg"
          />
        </div>

        {/* Neutral recent-week activity history */}
        {history.length > 0 && (
          <div>
            <p className="text-subtle text-xs mb-2">Recent weeks</p>
            <div className="flex gap-1">
              {history.slice(-8).map((week) => {
                const weekHasTraining = week.activityCount > 0 || week.trainingHours > 0;
                return (
                  <div
                    key={week.weekStart}
                    className={`flex-1 h-2 rounded-full ${
                      weekHasTraining ? "bg-accent/60" : "bg-surface-hover"
                    }`}
                    title={`${week.weekStart}: ${
                      weekHasTraining
                        ? formatDurationMinutes(week.trainingHours * 60)
                        : "No training"
                    }`}
                  />
                );
              })}
              {hasTraining ? (
                <div
                  className="flex-1 h-2 rounded-full ring-2 ring-border-strong bg-accent"
                  title={`This week: ${formatDurationMinutes(current.trainingHours * 60)}`}
                />
              ) : (
                <div
                  className="flex-1 h-2 rounded-full ring-2 ring-border-strong bg-surface-hover"
                  title="This week: No training"
                />
              )}
            </div>
          </div>
        )}
      </div>
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
