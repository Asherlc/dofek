import { useState } from "react";
import { chartColors, dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

export function ClimbingVolumeOverTimeChart({
  data,
  loading,
}: {
  data: { week: string; attempts: number | null; minutes: number | null }[];
  loading?: boolean;
}) {
  const [metric, setMetric] = useState<"attempts" | "time">("attempts");
  const label = metric === "attempts" ? "Attempts" : "Time (minutes)";
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
      {data.some((row) => (metric === "attempts" ? row.attempts : row.minutes) === null) ? (
        <p className="text-xs text-muted">Weeks with incomplete records are not plotted.</p>
      ) : null}
      <DofekChart
        option={{
          grid: dofekGrid("single"),
          tooltip: dofekTooltip(),
          xAxis: dofekAxis.time({ show: true }),
          yAxis: dofekAxis.value({ name: label }),
          series: [
            dofekSeries.bar(
              label,
              data.map((row) => [row.week, metric === "attempts" ? row.attempts : row.minutes]),
              { color: chartColors.emerald },
            ),
          ],
        }}
        loading={loading}
        empty={data.length === 0}
        height={280}
        emptyMessage="No climbing volume data"
      />
    </>
  );
}
