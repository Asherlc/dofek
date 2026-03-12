import type { RampRateWeek } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

interface RampRateChartProps {
  data: RampRateWeek[];
  currentRampRate: number;
  recommendation: string;
  loading?: boolean;
}

function getRampColor(rate: number): string {
  const absRate = Math.abs(rate);
  if (absRate < 5) return "#22c55e";
  if (absRate <= 7) return "#eab308";
  return "#ef4444";
}

export function RampRateChart({
  data,
  currentRampRate,
  recommendation,
  loading,
}: RampRateChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading ramp rate data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No ramp rate data available</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 50, right: 20, bottom: 50, left: 55 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter(params: Array<{ dataIndex: number; value: [string, number]; marker: string }>) {
        if (!params.length) return "";
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const d = data[idx];
        if (!d) return "";
        const color = getRampColor(d.rampRate);
        const dateLabel = new Date(d.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return [
          `<strong>${dateLabel}</strong>`,
          `Ramp Rate: <span style="color:${color}">${d.rampRate.toFixed(2)}</span>`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value" as const,
      name: "Ramp Rate (CTL/week)",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Ramp Rate",
        type: "bar",
        data: data.map((d) => ({
          value: [d.week, d.rampRate],
          itemStyle: { color: getRampColor(d.rampRate) },
        })),
      },
      {
        name: "Safe Threshold",
        type: "line",
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#eab308", type: "dashed" as const, width: 1 },
          data: [{ yAxis: 5, label: { formatter: "Safe Limit", color: "#eab308", fontSize: 10 } }],
        },
        data: [],
      },
    ],
  };

  const badgeColor = getRampColor(currentRampRate);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border"
          style={{
            color: badgeColor,
            borderColor: `${badgeColor}40`,
            backgroundColor: `${badgeColor}15`,
          }}
        >
          Current: {currentRampRate.toFixed(2)}
        </span>
        <span className="text-xs text-zinc-500">{recommendation}</span>
      </div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
