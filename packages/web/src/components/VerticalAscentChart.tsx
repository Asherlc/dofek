import { formatDateShort, formatNumber } from "@dofek/format/format";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { VerticalAscentRow } from "dofek-server/types";
import { chartColors, dofekAxis, dofekGrid, dofekLegend, dofekTooltip } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface VerticalAscentChartProps {
  data: VerticalAscentRow[];
  loading?: boolean;
}

const ACTIVITY_TYPE_COLORS: Record<string, string> = {
  road_cycling: chartColors.teal,
  mountain_biking: chartColors.purple,
  gravel_cycling: chartColors.orange,
  cycling: chartColors.blue,
  indoor_cycling: chartColors.green,
  virtual_cycling: chartColors.green,
  e_bike_cycling: chartColors.emerald,
  cyclocross: chartColors.amber,
  track_cycling: chartColors.pink,
  bmx: chartColors.pink,
  hand_cycling: chartColors.emerald,
};

function colorForActivityType(activityType: string): string {
  return ACTIVITY_TYPE_COLORS[activityType] ?? chartColors.blue;
}

export function VerticalAscentChart({ data, loading }: VerticalAscentChartProps) {
  const units = useUnitConverter();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={300} />;
  }

  if (data.length === 0) {
    return (
      <DofekChart
        option={{}}
        empty={true}
        height={300}
        emptyMessage="No activities with altitude data available"
      />
    );
  }

  // Scale bubble size by elevation gain
  const maxGain = Math.max(...data.map((d) => units.convertElevation(d.elevationGainMeters)));
  const minSize = 8;
  const maxSize = 40;

  const eLabel = units.elevationLabel;
  const scatterData = data.map((d) => ({
    value: [d.date, units.convertElevation(d.verticalAscentRate)],
    name: d.activityName,
    activityType: d.activityType,
    elevationGain: units.convertElevation(d.elevationGainMeters),
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));
  const activityTypes = [...new Set(scatterData.map((point) => point.activityType))];

  const option = {
    grid: dofekGrid("single", { top: activityTypes.length > 1 ? 64 : 40, bottom: 46 }),
    legend: dofekLegend(activityTypes.length > 1, {
      data: activityTypes.map((activityType) => formatActivityTypeLabel(activityType)),
    }),
    tooltip: dofekTooltip({
      trigger: "item",
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
          activityType:
            "activityType" in rawData && typeof rawData.activityType === "string"
              ? rawData.activityType
              : "",
        };
        if (!itemData.name) return "";
        const [date, vam] = itemData.value;
        return [
          `<strong>${itemData.name}</strong>`,
          `Type: ${formatActivityTypeLabel(itemData.activityType)}`,
          `Date: ${formatDateShort(date)}`,
          `VAM: ${formatNumber(vam, 0)} ${eLabel}/h`,
          `Elevation Gain: ${formatNumber(itemData.elevationGain, 0)} ${eLabel}`,
        ].join("<br/>");
      },
    }),
    xAxis: { ...dofekAxis.time(), name: "Date" },
    yAxis: dofekAxis.value({ name: `VAM (${eLabel}/h)` }),
    series: activityTypes.map((activityType) => ({
      name: formatActivityTypeLabel(activityType),
      type: "scatter",
      data: scatterData
        .filter((point) => point.activityType === activityType)
        .map((d) => ({
          value: d.value,
          name: d.name,
          activityType: d.activityType,
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
        color: colorForActivityType(activityType),
        opacity: 0.7,
      },
    })),
  };

  return (
    <div>
      <DofekChart option={option} height={300} />
      <p className="text-xs text-dim mt-1">
        Bubble size indicates elevation gain. Higher VAM = stronger climbing performance.
      </p>
    </div>
  );
}
