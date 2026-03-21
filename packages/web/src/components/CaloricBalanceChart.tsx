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
        <span className="text-dim text-sm">Need both nutrition and energy expenditure data</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 12, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
    },
    legend: {
      top: 0,
      textStyle: { color: "#6b8a6b", fontSize: 11 },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.25)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: "kcal",
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
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
