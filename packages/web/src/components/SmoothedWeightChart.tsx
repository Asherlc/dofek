import ReactECharts from "echarts-for-react";
import type { SmoothedWeightRow } from "../../../server/src/routers/body-analytics.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertWeight, weightLabel } from "../lib/units.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface SmoothedWeightChartProps {
  data: SmoothedWeightRow[];
  loading?: boolean;
}

export function SmoothedWeightChart({ data, loading }: SmoothedWeightChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return <ChartLoadingSkeleton height={250} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[250px]">
        <span className="text-dim text-sm">No weight data available</span>
      </div>
    );
  }

  const latestWeeklyChange = data[data.length - 1]?.weeklyChange;

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 50, bottom: 30, left: 50 },
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
    yAxis: [
      {
        type: "value" as const,
        name: weightLabel(unitSystem),
        min: "dataMin" as const,
        axisLabel: { color: "#6b8a6b", fontSize: 11 },
        splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
        nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: `${weightLabel(unitSystem)}/week`,
        position: "right" as const,
        axisLabel: { color: "#6b8a6b", fontSize: 11 },
        splitLine: { show: false },
        nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
      },
    ],
    series: [
      {
        name: "Raw Weight",
        type: "scatter",
        data: data.map((d) => [d.date, convertWeight(d.rawWeight, unitSystem)]),
        symbolSize: 4,
        itemStyle: { color: "#6b8a6b", opacity: 0.5 },
      },
      {
        name: "Trend",
        type: "line",
        data: data.map((d) => [d.date, convertWeight(d.smoothedWeight, unitSystem)]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: "#06b6d4", width: 3 },
        itemStyle: { color: "#06b6d4" },
      },
      {
        name: "Weekly Change",
        type: "bar",
        yAxisIndex: 1,
        data: data
          .filter((d) => d.weeklyChange != null)
          .map((d) => [d.date, convertWeight(d.weeklyChange ?? 0, unitSystem)]),
        itemStyle: {
          color: (params: { value: [string, number] }) =>
            params.value[1] >= 0 ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
        },
        barWidth: "60%",
      },
    ],
  };

  return (
    <div className="space-y-2">
      {latestWeeklyChange != null && (
        <div className="flex items-baseline gap-2">
          <span
            className={`text-lg font-semibold ${latestWeeklyChange > 0 ? "text-green-400" : latestWeeklyChange < 0 ? "text-red-400" : "text-muted"}`}
          >
            {latestWeeklyChange > 0 ? "+" : ""}
            {convertWeight(latestWeeklyChange, unitSystem).toFixed(1)} {weightLabel(unitSystem)}
            /week
          </span>
        </div>
      )}
      <ReactECharts option={option} style={{ height: 250 }} />
    </div>
  );
}
