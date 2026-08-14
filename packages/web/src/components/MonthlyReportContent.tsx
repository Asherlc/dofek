import { formatDurationMinutes, formatHRV, formatMonthYear } from "@dofek/format/format";
import { textColors } from "@dofek/scoring/colors";
import type { MonthlyReportData, MonthSummary } from "dofek-server/types";
import { EmptyStatePreview } from "./EmptyStatePreview.tsx";
import { ReportDecisionSynthesis } from "./ReportDecisionSynthesis.tsx";

export function MonthlyReportContent({ data }: { data: MonthlyReportData | undefined }) {
  if (!data) {
    return (
      <div className="card p-6">
        <p className="text-sm text-dim">Not enough data for a monthly report yet.</p>
      </div>
    );
  }

  if (!data.current) {
    return <EmptyStatePreview content={data.emptyState} />;
  }

  return (
    <div className="space-y-4">
      {data.decisionSupport && <ReportDecisionSynthesis synthesis={data.decisionSupport} />}
      <div>
        <h3 className="text-xs text-muted uppercase tracking-wider mb-2">Current Month</h3>
        <MonthCard month={data.current} />
      </div>
      {data.history.length > 0 && (
        <div>
          <h3 className="text-xs text-muted uppercase tracking-wider mb-2">Previous Months</h3>
          <div className="space-y-3">
            {[...data.history].reverse().map((month) => (
              <MonthCard key={month.monthStart} month={month} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrendBadge({ value }: { value: number | null }) {
  if (value == null) return null;
  const isPositive = value > 0;
  const sign = isPositive ? "+" : "";
  return (
    <span className="text-xs tabular-nums" style={{ color: textColors.secondary }}>
      {sign}
      {value.toFixed(1)}%
    </span>
  );
}

function MonthCard({ month }: { month: MonthSummary }) {
  return (
    <div className="card p-5">
      <h4 className="text-sm font-medium text-foreground mb-3">
        {formatMonthYear(month.monthStart)}
      </h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <span className="text-xs text-muted block">Training</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatDurationMinutes(month.trainingHours * 60)}
          </span>
          <span className="ml-1">
            <TrendBadge value={month.trainingHoursTrend} />
          </span>
        </div>
        <div>
          <span className="text-xs text-muted block">Activities</span>
          <span className="text-lg font-semibold tabular-nums">{month.activityCount}</span>
        </div>
        <div>
          <span className="text-xs text-muted block">Avg Strain</span>
          <span className="text-lg font-semibold tabular-nums">{month.avgDailyStrain}</span>
        </div>
        <div>
          <span className="text-xs text-muted block">Avg Sleep</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatDurationMinutes(month.avgSleepMinutes)}
          </span>
          <span className="ml-1">
            <TrendBadge value={month.avgSleepTrend} />
          </span>
        </div>
        {month.avgRestingHr != null && (
          <div>
            <span className="text-xs text-muted block">Avg Resting HR</span>
            <span className="text-lg font-semibold tabular-nums">{month.avgRestingHr} bpm</span>
          </div>
        )}
        {month.avgHrv != null && (
          <div>
            <span className="text-xs text-muted block">Avg Heart Rate Variability</span>
            <span className="text-lg font-semibold tabular-nums">{formatHRV(month.avgHrv)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
