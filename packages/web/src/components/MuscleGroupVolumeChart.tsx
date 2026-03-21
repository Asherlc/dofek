import type { MuscleGroupVolumeRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface MuscleGroupVolumeChartProps {
  data: MuscleGroupVolumeRow[];
  loading?: boolean;
}

const COLORS = [
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#a855f7",
  "#06b6d4",
];

export function MuscleGroupVolumeChart({ data, loading }: MuscleGroupVolumeChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={320} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-dim text-sm">No muscle group data</span>
      </div>
    );
  }

  // Collect all unique weeks across all muscle groups
  const allWeeks = new Set<string>();
  for (const group of data) {
    for (const w of group.weeklyData) {
      allWeeks.add(w.week);
    }
  }
  const sortedWeeks = Array.from(allWeeks).sort();

  const series = data.map((group, index) => {
    const weekMap = new Map(group.weeklyData.map((w) => [w.week, w.sets]));
    return {
      name: group.muscleGroup,
      type: "bar" as const,
      stack: "total",
      data: sortedWeeks.map((w) => [w, weekMap.get(w) ?? 0]),
      itemStyle: {
        color: COLORS[index % COLORS.length],
      },
      emphasis: {
        focus: "series" as const,
      },
    };
  });

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      axisPointer: { type: "shadow" },
    },
    legend: {
      type: "scroll",
      top: 0,
      textStyle: { color: "#4a6a4a", fontSize: 11 },
      pageTextStyle: { color: "#4a6a4a" },
      pageIconColor: "#6b8a6b",
      pageIconInactiveColor: "rgba(74, 158, 122, 0.2)",
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
    },
    yAxis: {
      type: "value",
      name: "Sets",
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
    },
    series,
  };

  return <ReactECharts option={option} style={{ height: 320 }} />;
}
