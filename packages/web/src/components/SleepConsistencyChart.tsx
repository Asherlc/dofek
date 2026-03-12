import ReactECharts from "echarts-for-react";
import type { SleepConsistencyRow } from "../../../server/src/routers/recovery.ts";

interface SleepConsistencyChartProps {
  data: SleepConsistencyRow[];
  loading?: boolean;
}

function formatHour(h: number): string {
  const hour = Math.floor(h) % 24;
  const min = Math.round((h % 1) * 60);
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${String(min).padStart(2, "0")} ${period}`;
}

export function SleepConsistencyChart({ data, loading }: SleepConsistencyChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-zinc-600 text-sm">No sleep data available</span>
      </div>
    );
  }

  const latest = data[data.length - 1];
  const latestScore = latest?.consistencyScore;

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 50, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: Array<{ seriesName: string; value: [string, number]; dataIndex: number }>,
      ) => {
        const d = data[params[0]?.dataIndex ?? 0];
        if (!d) return "";
        return `<b>${d.date}</b><br/>
          Bedtime: ${formatHour(d.bedtimeHour)}<br/>
          Wake: ${formatHour(d.waketimeHour)}<br/>
          ${d.consistencyScore != null ? `Consistency: <b>${d.consistencyScore}/100</b>` : ""}`;
      },
    },
    legend: {
      top: 0,
      textStyle: { color: "#71717a", fontSize: 11 },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Score",
        min: 0,
        max: 100,
        axisLabel: { color: "#71717a", fontSize: 11 },
        splitLine: { lineStyle: { color: "#27272a" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Stddev (hrs)",
        position: "right" as const,
        axisLabel: { color: "#71717a", fontSize: 11 },
        splitLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
    ],
    series: [
      {
        name: "Consistency Score",
        type: "line",
        data: data
          .filter((d) => d.consistencyScore != null)
          .map((d) => [d.date, d.consistencyScore]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#8b5cf6", width: 2 },
        itemStyle: { color: "#8b5cf6" },
        areaStyle: { color: "rgba(139,92,246,0.1)" },
      },
      {
        name: "Bedtime Stddev",
        type: "line",
        yAxisIndex: 1,
        data: data
          .filter((d) => d.rollingBedtimeStddev != null)
          .map((d) => [d.date, d.rollingBedtimeStddev]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#06b6d4", width: 1.5 },
        itemStyle: { color: "#06b6d4" },
      },
      {
        name: "Wake Stddev",
        type: "line",
        yAxisIndex: 1,
        data: data
          .filter((d) => d.rollingWaketimeStddev != null)
          .map((d) => [d.date, d.rollingWaketimeStddev]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#f59e0b", width: 1.5 },
        itemStyle: { color: "#f59e0b" },
      },
    ],
  };

  return (
    <div className="space-y-2">
      {latestScore != null && (
        <div className="flex items-baseline gap-2">
          <span
            className={`text-2xl font-bold ${
              latestScore >= 80
                ? "text-green-400"
                : latestScore >= 50
                  ? "text-yellow-400"
                  : "text-red-400"
            }`}
          >
            {latestScore}
          </span>
          <span className="text-sm text-zinc-400">/ 100 sleep consistency</span>
        </div>
      )}
      <ReactECharts option={option} style={{ height: 250 }} />
    </div>
  );
}
