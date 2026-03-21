import type { ElevationProfileRow } from "dofek-server/types";
import {
  chartColors,
  dofekAnimation,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertDistance, convertElevation, distanceLabel, elevationLabel } from "../lib/units.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ElevationGainChartProps {
  data: ElevationProfileRow[];
  loading?: boolean;
}

export function ElevationGainChart({ data, loading }: ElevationGainChartProps) {
  const { unitSystem } = useUnitSystem();

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
          `Elevation Gain: ${convertElevation(row.elevationGainMeters, unitSystem).toFixed(0)} ${elevationLabel(unitSystem)}`,
          `Activities: ${row.activityCount}`,
          `Distance: ${convertDistance(row.totalDistanceKm, unitSystem).toFixed(1)} ${distanceLabel(unitSystem)}`,
        ].join("<br/>");
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: `Elevation Gain (${elevationLabel(unitSystem)})` }),
    series: [
      {
        ...dofekSeries.bar(
          "",
          data.map((d) => [d.week, convertElevation(d.elevationGainMeters, unitSystem)]),
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
        empty={data.length === 0}
        height={280}
        emptyMessage="No elevation data available"
      />
    </div>
  );
}
