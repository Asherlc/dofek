import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface NutritionData {
  date: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

interface NutritionChartProps {
  data: NutritionData[];
  loading?: boolean;
}

export function NutritionChart({ data, loading }: NutritionChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={200} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">No nutrition data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 60, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: [
      {
        type: "value",
        name: "kcal",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value",
        name: "grams",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right",
      },
    ],
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series: [
      {
        name: "Calories",
        type: "bar",
        data: data.map((d) => [d.date, d.calories]),
        itemStyle: { color: "#f59e0b", opacity: 0.6 },
        yAxisIndex: 0,
      },
      {
        name: "Protein",
        type: "line",
        data: data.map((d) => [d.date, d.protein_g]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#ef4444", width: 2 },
        itemStyle: { color: "#ef4444" },
        yAxisIndex: 1,
      },
      {
        name: "Carbs",
        type: "line",
        data: data.map((d) => [d.date, d.carbs_g]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#3b82f6", width: 2 },
        itemStyle: { color: "#3b82f6" },
        yAxisIndex: 1,
      },
      {
        name: "Fat",
        type: "line",
        data: data.map((d) => [d.date, d.fat_g]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#a855f7", width: 2 },
        itemStyle: { color: "#a855f7" },
        yAxisIndex: 1,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 200 }} notMerge={true} />;
}
