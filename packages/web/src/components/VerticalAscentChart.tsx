import { formatNumber } from "@dofek/format/format";
import type { VerticalAscentRow } from "dofek-server/types";
import { chartColors, dofekAxis, dofekGrid, dofekTooltip } from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface VerticalAscentChartProps {
  data: VerticalAscentRow[];
  loading?: boolean;
  error?: boolean;
}

export function VerticalAscentChart({ data, loading, error }: VerticalAscentChartProps) {
  const units = useUnitConverter();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={300} />;
  }

  if (error) {
    return <DofekChart option={{}} error={true} height={300} />;
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
    elevationGain: units.convertElevation(d.elevationGainMeters),
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));

  const option = {
    grid: dofekGrid("single", { top: 40, bottom: 30 }),
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
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: `VAM (${eLabel}/h)` }),
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
          color: chartColors.purple,
          opacity: 0.7,
        },
      },
    ],
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
