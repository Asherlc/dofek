import type { TrainingMonotonyWeek } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { createChartOptions } from "../lib/chart-theme.ts";
import { formatNumber } from "../lib/format.ts";
import { ChartContainer } from "./ChartContainer.tsx";

interface TrainingMonotonyChartProps {
  data: TrainingMonotonyWeek[];
  loading?: boolean;
}

export function TrainingMonotonyChart({ data, loading }: TrainingMonotonyChartProps) {
  const option = createChartOptions({
    grid: { top: 50, right: 70, bottom: 50, left: 55 },
    tooltip: {
      trigger: "axis" as const,
      formatter(
        params: Array<{
          seriesName: string;
          value: [string, number];
          marker: string;
          dataIndex: number;
        }>,
      ) {
        if (!params.length) return "";
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const d = data[idx];
        if (!d) return "";
        const dateLabel = new Date(d.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const monotonyColor = d.monotony > 2.0 ? "#ef4444" : "#3b82f6";
        return [
          `<strong>${dateLabel}</strong>`,
          `Monotony: <span style="color:${monotonyColor}">${formatNumber(d.monotony, 2)}</span>${d.monotony > 2.0 ? " (high!)" : ""}`,
          `Strain: ${formatNumber(d.strain)}`,
        ].join("<br/>");
      },
    },
    legend: {
      data: ["Monotony", "Strain"],
      top: 0,
    },
    xAxis: {
      type: "time" as const,
    },
    yAxis: [
      {
        type: "value" as const,
        name: "Monotony",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
      },
      {
        type: "value" as const,
        name: "Strain",
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    series: [
      {
        name: "Monotony",
        type: "bar",
        data: data.map((d) => ({
          value: [d.week, d.monotony],
          itemStyle: {
            color: d.monotony > 2.0 ? "#ef4444" : "#3b82f6",
          },
        })),
        yAxisIndex: 0,
      },
      {
        name: "Strain",
        type: "line",
        data: data.map((d) => [d.week, d.strain]),
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { color: "#f97316", width: 2 },
        itemStyle: { color: "#f97316" },
        yAxisIndex: 1,
      },
    ],
  });

  return (
    <ChartContainer
      loading={!!loading}
      data={data}
      height={300}
      emptyMessage="No training monotony data available"
    >
      <div>
        <p className="text-xs text-zinc-600 mb-2">
          Monotony &gt; 2.0 (red) with high strain indicates elevated overtraining risk.
        </p>
        <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
      </div>
    </ChartContainer>
  );
}
