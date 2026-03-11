import ReactECharts from "echarts-for-react";

export interface EstimatedMaxHistoryPoint {
  date: string;
  estimatedMax: number;
}

export interface EstimatedMaxExercise {
  exerciseName: string;
  history: EstimatedMaxHistoryPoint[];
}

interface EstimatedMaxChartProps {
  exercises: EstimatedMaxExercise[];
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
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (exercises.length === 0) {
    return (
      <div className="flex items-center justify-center h-[320px]">
        <span className="text-zinc-600 text-sm">No estimated max data</span>
      </div>
    );
  }

  const allDates = new Set<string>();
  for (const exercise of exercises) {
    for (const point of exercise.history) {
      allDates.add(point.date);
    }
  }
  const sortedDates = Array.from(allDates).sort();
  const dateLabels = sortedDates.map((d) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  const series = exercises.map((exercise, index) => {
    const dateMap = new Map(exercise.history.map((h) => [h.date, h.estimatedMax]));
    return {
      name: exercise.exerciseName,
      type: "line" as const,
      data: sortedDates.map((d) => dateMap.get(d) ?? null),
      smooth: 0.3,
      symbol: "circle",
      symbolSize: 5,
      lineStyle: { width: 2, color: COLORS[index % COLORS.length] },
      itemStyle: { color: COLORS[index % COLORS.length] },
      connectNulls: true,
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
      data: dateLabels,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "e1RM (kg)",
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      axisLabel: { color: "#71717a", fontSize: 11 },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series,
  };

  return <ReactECharts option={option} style={{ height: 320 }} />;
}
