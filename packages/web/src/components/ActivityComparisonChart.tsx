import type { ActivityComparisonRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { formatPace } from "../lib/format.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertPace, paceLabel } from "../lib/units.ts";

interface ActivityComparisonChartProps {
  data: ActivityComparisonRow[];
  loading?: boolean;
}

const SERIES_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

export function ActivityComparisonChart({ data, loading }: ActivityComparisonChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-dim text-sm">Loading activity comparison data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">
          No repeated routes found (need 2+ instances with the same name)
        </span>
      </div>
    );
  }

  const series = data.map((route, index) => ({
    name: route.activityName,
    type: "line" as const,
    data: route.instances.map((instance) => [
      instance.date,
      convertPace(instance.averagePaceMinPerKm * 60, unitSystem),
    ]),
    symbol: "circle",
    symbolSize: 8,
    lineStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length], width: 2 },
    itemStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length] },
    connectNulls: true,
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 65 },
    tooltip: {
      trigger: "item",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter: (params: Record<string, unknown>) => {
        const rawValue = Array.isArray(params.value) ? params.value : ["", 0];
        const date = String(rawValue[0] ?? "");
        const pace = typeof rawValue[1] === "number" ? rawValue[1] : 0;
        const seriesName = String(params.seriesName ?? "");
        return [
          `<strong>${seriesName}</strong>`,
          `Date: ${date}`,
          `Pace: ${formatPace(pace)} ${paceLabel(unitSystem)}`,
        ].join("<br/>");
      },
    },
    legend: {
      textStyle: { color: "#4a6a4a", fontSize: 11 },
      top: 0,
      type: "scroll",
    },
    xAxis: {
      type: "time",
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: `Pace (min${paceLabel(unitSystem)})`,
      inverse: true,
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      axisLabel: {
        color: "#6b8a6b",
        fontSize: 11,
        formatter: (value: number) => formatPace(value),
      },
      axisLine: { show: true, lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
    },
    series,
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Repeated Route Comparison (lower = faster)
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
      <p className="text-xs text-dim mt-1">
        Each line tracks pace over time for a repeated route. Y-axis is inverted so lower (faster)
        pace appears higher.
      </p>
    </div>
  );
}
