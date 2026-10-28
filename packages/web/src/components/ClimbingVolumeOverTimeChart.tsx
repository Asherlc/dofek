import { formatDurationHoursMinutes, formatNumber } from "@dofek/format/format";
import { useState } from "react";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

export function ClimbingVolumeOverTimeChart({
  data,
  loading,
}: {
  data: { week: string; attempts: number | null; minutes: number | null }[];
  loading?: boolean;
}) {
  const [metric, setMetric] = useState<"attempts" | "time">("attempts");
  const maxMinutes = data.reduce((max, row) => Math.max(max, row.minutes ?? 0), 0);
  const useHours = metric === "time" && maxMinutes >= 60;
  const label = metric === "attempts" ? "Attempts" : useHours ? "Time (h:mm)" : "Time (minutes)";
  const formatValue = useHours
    ? formatDurationHoursMinutes
    : (value: number) => formatNumber(value, 0);
  const hourInterval = Math.max(1, Math.ceil(maxMinutes / 60 / 6)) * 60;
  const points = data.map((row) => {
    const value = metric === "attempts" ? row.attempts : row.minutes;
    return {
      value: [row.week, value],
      displayValue: value == null ? "Not recorded" : formatValue(value),
    };
  });
  return (
    <>
      <div className="mb-3">
        <select
          aria-label="Climbing volume metric"
          className="min-h-11 cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          value={metric}
          onChange={(event) => setMetric(event.target.value === "time" ? "time" : "attempts")}
        >
          <option value="attempts">Attempts</option>
          <option value="time">Time</option>
        </select>
      </div>
      <DofekChart
        option={{
          grid: dofekGrid("single"),
          tooltip: dofekTooltip({
            formatter(params: { dataIndex: number }[]) {
              const index = params[0]?.dataIndex;
              const row = index == null ? undefined : data[index];
              const point = index == null ? undefined : points[index];
              if (!row || !point) return "";
              return `${escapeTooltipHtml(row.week)}<br/>${label}: ${point.displayValue}`;
            },
          }),
          xAxis: dofekAxis.time({ show: true }),
          yAxis: {
            ...dofekAxis.value({
              name: label,
              min: 0,
              axisLabel: useHours ? { formatter: formatDurationHoursMinutes } : undefined,
            }),
            ...(useHours
              ? { interval: hourInterval, max: Math.ceil(maxMinutes / hourInterval) * hourInterval }
              : {}),
          },
          series: [dofekSeries.bar(label, points, { color: chartColors.emerald })],
        }}
        loading={loading}
        empty={data.length === 0}
        height={280}
        emptyMessage="No climbing volume data"
      />
    </>
  );
}
