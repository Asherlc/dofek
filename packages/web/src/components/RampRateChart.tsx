import { rampRateColor } from "@dofek/scoring/scoring";
import type { RampRateWeek } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekTooltip } from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

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
    grid: dofekGrid("single", { top: 50, bottom: 50, left: 55 }),
    tooltip: dofekTooltip({
      formatter(params: Array<{ dataIndex: number; value: [string, number]; marker: string }>) {
        if (!params.length) return "";
        const first = params[0];
        if (!first) return "";
        const idx = first.dataIndex;
        const dataPoint = data[idx];
        if (!dataPoint) return "";
        const color = rampRateColor(dataPoint.rampRate);
        const dateLabel = new Date(dataPoint.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return [
          `<strong>${dateLabel}</strong>`,
          `Ramp Rate: <span style="color:${color}">${formatNumber(dataPoint.rampRate, 2)}</span>`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Ramp Rate (fitness/week)" }),
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
  const option = data.length > 0 ? buildRampRateOption(data) : {};
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
          Current: {formatNumber(currentRampRate, 2)}
        </span>
        <span className="text-xs text-subtle">{recommendation}</span>
      </div>
      <DofekChart
        option={option}
        loading={loading}
        empty={data.length === 0}
        height={300}
        emptyMessage="No ramp rate data available"
      />
    </div>
  );
}
