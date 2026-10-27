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
      <label>
        Metric{" "}
        <select
          aria-label="Climbing volume metric"
          value={metric}
          onChange={(event) => setMetric(event.target.value === "time" ? "time" : "attempts")}
        >
          <option value="attempts">Attempts</option>
          <option value="time">Time</option>
        </select>
      </label>
      {data.some((row) => (metric === "attempts" ? row.attempts : row.minutes) === null) ? (
        <p className="text-xs text-muted">Weeks with incomplete records are not plotted.</p>
      ) : null}
      <DofekChart
        option={{
          grid: dofekGrid("single"),
          tooltip: dofekTooltip(),
          xAxis: dofekAxis.time(),
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
