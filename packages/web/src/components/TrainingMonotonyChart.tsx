import ReactECharts from "echarts-for-react";

export interface TrainingMonotonyDataPoint {
  week: string;
  monotony: number;
  strain: number;
}

export interface TrainingMonotonyChartProps {
  data: TrainingMonotonyDataPoint[];
  loading?: boolean;
}

export function TrainingMonotonyChart({ data, loading }: TrainingMonotonyChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading monotony data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No training monotony data available</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 50, right: 70, bottom: 50, left: 55 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter(
        params: Array<{
          seriesName: string;
          value: [string, number];
          marker: string;
          dataIndex: number;
        }>,
      ) {
        if (!params.length) return "";
        const d = data[params[0].dataIndex];
        const dateLabel = new Date(d.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const monotonyColor = d.monotony > 2.0 ? "#ef4444" : "#3b82f6";
        return [
          `<strong>${dateLabel}</strong>`,
          `Monotony: <span style="color:${monotonyColor}">${d.monotony.toFixed(2)}</span>${d.monotony > 2.0 ? " (high!)" : ""}`,
          `Strain: ${d.strain.toFixed(1)}`,
        ].join("<br/>");
      },
    },
    legend: {
      data: ["Monotony", "Strain"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
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
  };

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-2">
        Monotony &gt; 2.0 (red) with high strain indicates elevated overtraining risk.
      </p>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
