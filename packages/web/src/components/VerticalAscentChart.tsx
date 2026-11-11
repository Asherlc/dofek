import { formatDateShort, formatNumber } from "@dofek/format/format";
import {
  formatActivityTypeLabel,
  formatVerticalAscentActivityTypeGroupLabel,
  getVerticalAscentActivityTypeGroup,
  type VerticalAscentActivityTypeGroup,
} from "@dofek/training/training";
import { useNavigate } from "@tanstack/react-router";
import type { TrainingChartAvailability, VerticalAscentRow } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

interface VerticalAscentChartProps {
  data: VerticalAscentRow[];
  loading?: boolean;
  availability?: TrainingChartAvailability;
}

const ACTIVITY_TYPE_GROUP_COLORS: Record<VerticalAscentActivityTypeGroup, string> = {
  road_cycling: chartColors.teal,
  mountain_biking: chartColors.purple,
  gravel_cycling: chartColors.orange,
  other_cycling: chartColors.blue,
};

function colorForActivityTypeGroup(activityTypeGroup: VerticalAscentActivityTypeGroup): string {
  return ACTIVITY_TYPE_GROUP_COLORS[activityTypeGroup];
}

export function VerticalAscentChart({ data, loading, availability }: VerticalAscentChartProps) {
  const units = useUnitConverter();
  const navigate = useNavigate();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={300} />;
  }

  if (availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
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
  const maxGain = Math.max(...data.map((point) => point.elevationGainMeters));
  const minSize = 8;
  const maxSize = 40;

  const eLabel = units.elevationLabel;
  const scatterData = data.map((d) => ({
    activityId: d.activityId,
    value: [d.date, units.convertElevation(d.verticalAscentRate)],
    name: d.activityName,
    activityType: d.activityType,
    activityTypeGroup: getVerticalAscentActivityTypeGroup(d.modality),
    elevationGain: units.convertElevation(d.elevationGainMeters),
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));
  const activityTypeGroups = [...new Set(scatterData.map((point) => point.activityTypeGroup))];

  const option = {
    grid: dofekGrid("single", { top: activityTypeGroups.length > 1 ? 64 : 40, bottom: 46 }),
    legend: dofekLegend(activityTypeGroups.length > 1, {
      data: activityTypeGroups.map((activityTypeGroup) =>
        formatVerticalAscentActivityTypeGroupLabel(activityTypeGroup),
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
              : undefined,
        };
        if (!itemData.name) return "";
        const [date, vam] = itemData.value;
        return [
          `<strong>${escapeTooltipHtml(itemData.name)}</strong>`,
          `Type: ${escapeTooltipHtml(
            itemData.activityType ? formatActivityTypeLabel(itemData.activityType) : "Other",
          )}`,
          `Date: ${escapeTooltipHtml(formatDateShort(date))}`,
          `Vertical Ascent Rate: ${formatNumber(vam, 0)} ${escapeTooltipHtml(eLabel)}/h`,
          `Elevation Gain: ${formatNumber(itemData.elevationGain, 0)} ${escapeTooltipHtml(eLabel)}`,
        ].join("<br/>");
      },
    }),
    xAxis: { ...dofekAxis.time(), name: "Date" },
    yAxis: dofekAxis.value({ name: `Vertical Ascent Rate (${eLabel}/h)` }),
    series: activityTypeGroups.map((activityTypeGroup) => ({
      name: formatVerticalAscentActivityTypeGroupLabel(activityTypeGroup),
      type: "scatter",
      data: scatterData
        .filter((point) => point.activityTypeGroup === activityTypeGroup)
        .map((d) => ({
          activityId: d.activityId,
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
      <DofekChart
        option={option}
        height={300}
        onEvents={{
          click: (params) => {
            const point = params.data;
            if (
              point &&
              typeof point === "object" &&
              "activityId" in point &&
              typeof point.activityId === "string"
            ) {
              navigate({ to: "/activity/$id", params: { id: point.activityId } });
            }
          },
        }}
        dataDisclosure={
          <details className="mt-2 text-xs text-dim">
            <summary className="cursor-pointer font-medium text-foreground">
              View chart data
            </summary>
            <ul className="mt-2 max-h-72 space-y-2 overflow-auto">
              {data.map((point) => (
                <li key={point.activityId}>
                  <a
                    className="text-accent underline"
                    href={`/activity/${encodeURIComponent(point.activityId)}`}
                  >
                    {point.activityName}
                  </a>
                  {" · "}
                  {formatDateShort(point.date)}
                  {" · "}
                  {formatNumber(units.convertElevation(point.verticalAscentRate), 0)} {eLabel}/h
                  {" · "}
                  {formatNumber(units.convertElevation(point.elevationGainMeters), 0)} {eLabel}{" "}
                  elevation gain
                  {" · "}
                  {formatNumber(point.elapsedMinutes, 0)} minutes
                </li>
              ))}
            </ul>
          </details>
        }
      />
      <p className="text-xs text-dim mt-1">Bubble size: elevation gain</p>
    </div>
  );
}
