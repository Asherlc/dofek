import type { VerticalAscentRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { formatNumber } from "../lib/format.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertElevation, elevationLabel } from "../lib/units.ts";

interface VerticalAscentChartProps {
  data: VerticalAscentRow[];
  loading?: boolean;
}

export function VerticalAscentChart({ data, loading }: VerticalAscentChartProps) {
  const { unitSystem } = useUnitSystem();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading vertical ascent data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No activities with altitude data available</span>
      </div>
    );
  }

  // Scale bubble size by elevation gain
  const maxGain = Math.max(...data.map((d) => convertElevation(d.elevationGainMeters, unitSystem)));
  const minSize = 8;
  const maxSize = 40;

  const eLabel = elevationLabel(unitSystem);
  const scatterData = data.map((d) => ({
    value: [d.date, convertElevation(d.verticalAscentRate, unitSystem)],
    name: d.activityName,
    elevationGain: convertElevation(d.elevationGainMeters, unitSystem),
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>) => {
        const rawData = params.data;
        if (!rawData || typeof rawData !== "object" || !("name" in rawData)) return "";
        const itemData = {
          name: String(rawData.name ?? ""),
          value: "value" in rawData && Array.isArray(rawData.value) ? rawData.value : ["", 0],
          elevationGain:
            "elevationGain" in rawData && typeof rawData.elevationGain === "number"
              ? rawData.elevationGain
              : 0,
        };
        if (!itemData.name) return "";
        const [date, vam] = itemData.value;
        return [
          `<strong>${itemData.name}</strong>`,
          `Date: ${new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
          `VAM: ${formatNumber(vam, 0)} ${eLabel}/h`,
          `Elevation Gain: ${formatNumber(itemData.elevationGain, 0)} ${eLabel}`,
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
      type: "value" as const,
      name: `VAM (${eLabel}/h)`,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Vertical Ascent Rate",
        type: "scatter",
        data: scatterData.map((d) => ({
          value: d.value,
          name: d.name,
          elevationGain: d.elevationGain,
          symbolSize: d.symbolSize,
        })),
        symbolSize: (_val: unknown, params: Record<string, unknown>) => {
          const rawData = params.data;
          if (
            rawData &&
            typeof rawData === "object" &&
            "symbolSize" in rawData &&
            typeof rawData.symbolSize === "number"
          ) {
            return rawData.symbolSize;
          }
          return minSize;
        },
        itemStyle: {
          color: "#8b5cf6",
          opacity: 0.7,
        },
      },
    ],
  };

  return (
    <div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
      <p className="text-xs text-zinc-600 mt-1">
        Bubble size indicates elevation gain. Higher VAM = stronger climbing performance.
      </p>
    </div>
  );
}
