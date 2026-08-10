import { formatDurationSeconds, formatNumber } from "@dofek/format/format";
import { Link } from "@tanstack/react-router";
import type { HangboardingSummary as HangboardingSummaryData } from "../../../server/src/repositories/hangboarding-repository.ts";
import { chartColors, dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface HangboardingSummaryProps {
  data: HangboardingSummaryData | undefined;
  loading: boolean;
}

function formatNullableDuration(value: number | null): string {
  return value == null ? "—" : formatDurationSeconds(value);
}

function formatNullableHeartRate(value: number | null): string {
  return value == null ? "—" : `${formatNumber(value, 0)} bpm`;
}

export function HangboardingSummary({ data, loading }: HangboardingSummaryProps) {
  if (data == null && loading) {
    return <QueryStatePanel variant="loading" contextLabel="Hangboarding summary" height={220} />;
  }

  if (data == null || data.sessionCount === 0) {
    return <QueryStatePanel variant="empty" message="No Hangboarding sessions yet." height={220} />;
  }

  const dailyDurationOption = {
    grid: dofekGrid("single", { top: 12, right: 20, bottom: 36, left: 52 }),
    tooltip: dofekTooltip(),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({
      name: "Duration",
      axisLabel: { formatter: (value: number) => formatDurationSeconds(value) },
    }),
    series: [
      dofekSeries.bar(
        "Session duration",
        data.daily.map((row) => [row.date, row.durationSeconds]),
        { color: chartColors.blue, barWidth: "55%" },
      ),
    ],
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="Sessions" value={String(data.sessionCount)} />
        <Metric label="Total Time" value={formatDurationSeconds(data.totalDurationSeconds)} />
        <Metric label="Avg Session" value={formatNullableDuration(data.averageDurationSeconds)} />
        <Metric label="Work Time" value={formatNullableDuration(data.totalWorkDurationSeconds)} />
        <Metric label="Rest Time" value={formatNullableDuration(data.totalRestDurationSeconds)} />
        <Metric label="Peak Heart Rate" value={formatNullableHeartRate(data.peakHeartRate)} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">
          Daily Duration
        </h3>
        <DofekChart
          option={dailyDurationOption}
          loading={loading && data.daily.length === 0}
          empty={data.daily.length === 0}
          emptyMessage="No daily Hangboarding duration"
          height={190}
        />
      </div>

      {data.latestSession ? (
        <div className="rounded border border-border bg-surface px-3 py-2 text-sm">
          <div className="text-xs uppercase tracking-wider text-subtle">Latest Session</div>
          <Link
            to="/activity/$id"
            params={{ id: data.latestSession.activityId }}
            className="mt-1 inline-flex flex-wrap gap-x-2 text-foreground hover:text-accent"
          >
            <span>{data.latestSession.planName ?? "Hangboarding session"}</span>
            {data.latestSession.boardName ? (
              <span className="text-subtle">· {data.latestSession.boardName}</span>
            ) : null}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2">
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}
