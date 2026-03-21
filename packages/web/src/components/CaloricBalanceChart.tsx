import ReactECharts from "echarts-for-react";
import type { CaloricBalanceRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface CaloricBalanceChartProps {
  data: CaloricBalanceRow[];
  loading?: boolean;
}

export function CaloricBalanceChart({ data, loading }: CaloricBalanceChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={250} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-dim text-sm">
          Need both nutrition and energy expenditure data
        </span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 12, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
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
    yAxis: {
      type: "value" as const,
      name: "kcal",
      axisLabel: { color: "#71717a", fontSize: 11 },
      splitLine: { lineStyle: { color: "#27272a" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Balance",
        type: "bar",
        data: data.map((d) => [d.date, d.balance]),
        itemStyle: {
          color: (params: { value: [string, number] }) =>
            params.value[1] >= 0 ? "#22c55e" : "#ef4444",
        },
      },
      {
        name: "7-day Avg",
        type: "line",
        data: data
          .filter((d) => d.rollingAvgBalance != null)
          .map((d) => [d.date, d.rollingAvgBalance]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#8b5cf6", width: 2 },
        itemStyle: { color: "#8b5cf6" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 250 }} />;
}
