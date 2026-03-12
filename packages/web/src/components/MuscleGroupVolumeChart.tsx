import type { MuscleGroupVolumeRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

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
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-zinc-600 text-sm">No muscle group data</span>
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
  const weekLabels = sortedWeeks.map((w) =>
    new Date(w).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  const series = data.map((group, index) => {
    const weekMap = new Map(group.weeklyData.map((w) => [w.week, w.sets]));
    return {
      name: group.muscleGroup,
      type: "bar" as const,
      stack: "total",
      data: sortedWeeks.map((w) => weekMap.get(w) ?? 0),
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
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      axisPointer: { type: "shadow" },
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
      type: "category",
      data: weekLabels,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "Sets",
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      axisLabel: { color: "#71717a", fontSize: 11 },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series,
  };

  return <ReactECharts option={option} style={{ height: 320 }} />;
}
