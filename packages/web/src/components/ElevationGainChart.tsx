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
        <span className="text-dim text-sm">Loading elevation data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No elevation data available</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
      formatter: (params: Record<string, unknown>[]) => {
        const rawParam = params[0];
        if (!rawParam) return "";
        const param = {
          name: String(rawParam.name ?? ""),
          value: Array.isArray(rawParam.value) ? rawParam.value : ["", 0],
          dataIndex: typeof rawParam.dataIndex === "number" ? rawParam.dataIndex : 0,
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
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: `Elevation Gain (${elevationLabel(unitSystem)})`,
      splitLine: { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } },
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "rgba(74, 158, 122, 0.2)" } },
      nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
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
      <h3 className="text-xs font-medium text-subtle mb-2">
        Weekly Elevation Gain (Hiking & Walking)
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
    </div>
  );
}
