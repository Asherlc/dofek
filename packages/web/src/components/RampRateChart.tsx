import { rampRateColor } from "@dofek/scoring/scoring";
import type { RampRateWeek } from "dofek-server/types";
import ReactECharts from "echarts-for-react";

interface RampRateChartProps {
  data: RampRateWeek[];
  currentRampRate: number;
  recommendation: string;
  loading?: boolean;
}

interface RampRateWeekData {
  week: string;
  rampRate: number;
}

export function buildRampRateOption(data: RampRateWeekData[]) {
  return {
    backgroundColor: "transparent",
    grid: { top: 50, right: 20, bottom: 50, left: 55 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter(params: Array<{ dataIndex: number; value: [string, number]; marker: string }>) {
        if (!params.length) return "";
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const d = data[idx];
        if (!d) return "";
        const color = rampRateColor(d.rampRate);
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
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.25)" } },
    },
    yAxis: {
      type: "value" as const,
      name: "Ramp Rate (fitness/week)",
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
    },
    series: [
      {
        name: "Ramp Rate",
        type: "bar",
        data: data.map((d) => ({
          value: [d.week, d.rampRate],
          itemStyle: { color: rampRateColor(d.rampRate) },
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
          tooltip: { show: false },
        },
        data: [],
        tooltip: { show: false },
      },
    ],
  };
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
        <span className="text-dim text-sm">Loading ramp rate data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-dim text-sm">No ramp rate data available</span>
      </div>
    );
  }

  const option = buildRampRateOption(data);

  const badgeColor = rampRateColor(currentRampRate);

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
        <span className="text-xs text-subtle">{recommendation}</span>
      </div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
    </div>
  );
}
