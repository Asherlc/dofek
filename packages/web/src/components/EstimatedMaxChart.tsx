import type { EstimatedOneRepMaxRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface EstimatedMaxChartProps {
  exercises: EstimatedOneRepMaxRow[];
  loading?: boolean;
}

const COLORS = [
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

export function EstimatedMaxChart({ exercises, loading }: EstimatedMaxChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={320} />;
  }

  if (exercises.length === 0) {
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-zinc-600 text-sm">No estimated max data</span>
      </div>
    );
  }

  const series = exercises.map((exercise, index) => ({
    name: exercise.exerciseName,
    type: "line" as const,
    data: exercise.history.map((h) => [h.date, h.estimatedMax]),
    smooth: 0.3,
    symbol: "circle",
    symbolSize: 5,
    lineStyle: { width: 2, color: COLORS[index % COLORS.length] },
    itemStyle: { color: COLORS[index % COLORS.length] },
    connectNulls: true,
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
    },
    legend: {
      type: "scroll",
      top: 0,
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      pageTextStyle: { color: "#a1a1aa" },
      pageIconColor: "#71717a",
      pageIconInactiveColor: "#3f3f46",
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "Estimated 1-Rep Max (kg)",
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      axisLabel: { color: "#71717a", fontSize: 11 },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series,
  };

  return <ReactECharts option={option} style={{ height: 320 }} />;
}
