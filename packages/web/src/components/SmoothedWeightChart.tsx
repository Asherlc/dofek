import ReactECharts from "echarts-for-react";
import type { SmoothedWeightRow } from "../../../server/src/routers/body-analytics.ts";
import { createChartOptions } from "../lib/chart-theme.ts";
import { formatNumber } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ChartContainer } from "./ChartContainer.tsx";

interface SmoothedWeightChartProps {
  data: SmoothedWeightRow[];
  loading?: boolean;
}

export function SmoothedWeightChart({ data, loading }: SmoothedWeightChartProps) {
  const units = useUnitConverter();

  const latestWeeklyChange = data[data.length - 1]?.weeklyChange;

  const option = createChartOptions({
    grid: { top: 30, right: 50, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
    },
    legend: {
      top: 0,
      textStyle: { color: "#71717a", fontSize: 11 },
    },
    xAxis: {
      type: "time" as const,
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value" as const,
        name: units.weightLabel,
        min: "dataMin" as const,
        axisLabel: { color: "#71717a", fontSize: 11 },
        splitLine: { lineStyle: { color: "#27272a" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: `${units.weightLabel}/week`,
        position: "right" as const,
        axisLabel: { color: "#71717a", fontSize: 11 },
        splitLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
    ],
    series: [
      {
        name: "Raw Weight",
        type: "scatter",
        data: data.map((d) => [d.date, units.convertWeight(d.rawWeight)]),
        symbolSize: 4,
        itemStyle: { color: "#71717a", opacity: 0.5 },
      },
      {
        name: "Trend",
        type: "line",
        data: data.map((d) => [d.date, units.convertWeight(d.smoothedWeight)]),
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
          .map((d) => [d.date, units.convertWeight(d.weeklyChange ?? 0)]),
        itemStyle: {
          color: (params: { value: [string, number] }) =>
            params.value[1] >= 0 ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
        },
        barWidth: "60%",
      },
    ],
  });

  return (
    <ChartContainer
      loading={!!loading}
      data={data}
      height={250}
      emptyMessage="No weight data available"
    >
      <div className="space-y-2">
        {latestWeeklyChange != null && (
          <div className="flex items-baseline gap-2">
            <span
              className={`text-lg font-semibold ${latestWeeklyChange > 0 ? "text-green-400" : latestWeeklyChange < 0 ? "text-red-400" : "text-zinc-400"}`}
            >
              {latestWeeklyChange > 0 ? "+" : ""}
              {formatNumber(units.convertWeight(latestWeeklyChange))} {units.weightLabel}
              /week
            </span>
          </div>
        )}
        <ReactECharts option={option} style={{ height: 250 }} />
      </div>
    </ChartContainer>
  );
}
