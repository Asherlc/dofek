import { formatNumber } from "@dofek/format/format";
import type { ElevationProfileRow } from "dofek-server/types";
import {
  chartColors,
  dofekAnimation,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ElevationGainChartProps {
  data: ElevationProfileRow[];
  loading?: boolean;
  error?: boolean;
}

export function ElevationGainChart({ data, loading, error }: ElevationGainChartProps) {
  const units = useUnitConverter();

  const option = {
    ...dofekAnimation,
    grid: dofekGrid("single", { top: 40, left: 55 }),
    tooltip: dofekTooltip({
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
          `Elevation Gain: ${formatNumber(units.convertElevation(row.elevationGainMeters), 0)} ${units.elevationLabel}`,
          `Activities: ${row.activityCount}`,
          `Distance: ${formatNumber(units.convertDistance(row.totalDistanceKm))} ${units.distanceLabel}`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: `Elevation Gain (${units.elevationLabel})` }),
    series: [
      {
        ...dofekSeries.bar(
          "",
          data.map((d) => [d.week, units.convertElevation(d.elevationGainMeters)]),
          { color: chartColors.amber },
        ),
        barMaxWidth: 30,
      },
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Weekly Elevation Gain (Hiking & Walking)
      </h3>
      <DofekChart
        option={option}
        loading={loading}
        error={error}
        empty={data.length === 0}
        height={280}
        emptyMessage="No elevation data available"
      />
    </div>
  );
}
