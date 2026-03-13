import type { ElevationProfileRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertDistance, convertElevation, distanceLabel, elevationLabel } from "../lib/units.ts";

interface ElevationGainChartProps {
  data: ElevationProfileRow[];
  loading?: boolean;
}

export function ElevationGainChart({ data, loading }: ElevationGainChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading elevation data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No elevation data available</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>[]) => {
        const param = params[0] as {
          name: string;
          value: [string, number];
          dataIndex: number;
        };
        const row = data[param.dataIndex];
        if (!row) return "";
        const dateLabel = new Date(row.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return [
          `<strong>Week of ${dateLabel}</strong>`,
          `Elevation Gain: ${convertElevation(row.elevationGainMeters, unitSystem).toFixed(0)} ${elevationLabel(unitSystem)}`,
          `Activities: ${row.activityCount}`,
          `Distance: ${convertDistance(row.totalDistanceKm, unitSystem).toFixed(1)} ${distanceLabel(unitSystem)}`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: `Elevation Gain (${elevationLabel(unitSystem)})`,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: data.map((d) => [d.week, convertElevation(d.elevationGainMeters, unitSystem)]),
        itemStyle: { color: "#f59e0b" },
        barMaxWidth: 30,
      },
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Weekly Elevation Gain (Hiking & Walking)
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
    </div>
  );
}
