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

type ActivityTypeGroup = "road_cycling" | "mountain_biking" | "gravel_cycling" | "other_cycling";

const ACTIVITY_TYPE_GROUP_LABELS: Record<ActivityTypeGroup, string> = {
  road_cycling: "Road Cycling",
  mountain_biking: "Mountain Biking",
  gravel_cycling: "Gravel Cycling",
  other_cycling: "Other Cycling",
};

const ACTIVITY_TYPE_GROUP_COLORS: Record<ActivityTypeGroup, string> = {
  road_cycling: chartColors.teal,
  mountain_biking: chartColors.purple,
  gravel_cycling: chartColors.orange,
  other_cycling: chartColors.blue,
};

function groupForActivityType(activityType: string): ActivityTypeGroup {
  if (activityType === "road_cycling") return "road_cycling";
  if (activityType === "mountain_biking") return "mountain_biking";
  if (activityType === "gravel_cycling") return "gravel_cycling";
  return "other_cycling";
}

function labelForActivityTypeGroup(activityTypeGroup: ActivityTypeGroup): string {
  return ACTIVITY_TYPE_GROUP_LABELS[activityTypeGroup];
}

function colorForActivityTypeGroup(activityTypeGroup: ActivityTypeGroup): string {
  return ACTIVITY_TYPE_GROUP_COLORS[activityTypeGroup];
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
    activityTypeGroup: groupForActivityType(d.activityType),
    elevationGain: units.convertElevation(d.elevationGainMeters),
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));
  const activityTypeGroups = [...new Set(scatterData.map((point) => point.activityTypeGroup))];

  const option = {
    grid: dofekGrid("single", { top: activityTypeGroups.length > 1 ? 64 : 40, bottom: 46 }),
    legend: dofekLegend(activityTypeGroups.length > 1, {
      data: activityTypeGroups.map((activityTypeGroup) =>
        labelForActivityTypeGroup(activityTypeGroup),
      ),
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
    series: activityTypeGroups.map((activityTypeGroup) => ({
      name: labelForActivityTypeGroup(activityTypeGroup),
      type: "scatter",
      data: scatterData
        .filter((point) => point.activityTypeGroup === activityTypeGroup)
        .map((d) => ({
          value: d.value,
          name: d.name,
          activityType: d.activityType,
          activityTypeGroup: d.activityTypeGroup,
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
        color: colorForActivityTypeGroup(activityTypeGroup),
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
