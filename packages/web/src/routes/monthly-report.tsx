import { createFileRoute } from "@tanstack/react-router";
import { PageLayout } from "../components/PageLayout.tsx";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/monthly-report")({
  component: MonthlyReportPage,
});

function TrendBadge({ value }: { value: number | null }) {
  if (value == null) return null;
  const isPositive = value > 0;
  const color = isPositive ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-dim";
  const sign = isPositive ? "+" : "";
  return (
    <span className={`text-xs tabular-nums ${color}`}>
      {sign}
      {value.toFixed(1)}%
    </span>
  );
}

function MonthCard({
  month,
}: {
  month: {
    monthStart: string;
    trainingHours: number;
    activityCount: number;
    avgDailyStrain: number;
    avgSleepMinutes: number;
    avgRestingHr: number | null;
    avgHrv: number | null;
    trainingHoursTrend: number | null;
    avgSleepTrend: number | null;
  };
}) {
  const date = new Date(month.monthStart);
  const monthLabel = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const sleepHours = Math.round((month.avgSleepMinutes / 60) * 10) / 10;

  return (
    <div className="card p-5">
      <h4 className="text-sm font-medium text-foreground mb-3">{monthLabel}</h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <span className="text-xs text-muted block">Training</span>
          <span className="text-lg font-semibold tabular-nums">{month.trainingHours}h</span>
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
          <span className="text-lg font-semibold tabular-nums">{sleepHours}h</span>
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
            <span className="text-lg font-semibold tabular-nums">{month.avgHrv} ms</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MonthlyReportPage() {
  const { data, isLoading } = trpc.monthlyReport.report.useQuery({ months: 6 });

  return (
    <PageLayout title="Monthly Report" subtitle="Month-over-month performance trends">
      {isLoading ? (
        <div className="space-y-4">
          <div className="card p-5 animate-pulse h-32" />
          <div className="card p-5 animate-pulse h-32" />
        </div>
      ) : !data || (!data.current && data.history.length === 0) ? (
        <div className="card p-6">
          <p className="text-sm text-dim">Not enough data for a monthly report yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.current && (
            <div>
              <h3 className="text-xs text-muted uppercase tracking-wider mb-2">Current Month</h3>
              <MonthCard month={data.current} />
            </div>
          )}
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
      )}
    </PageLayout>
  );
}
