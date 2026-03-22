import type { ActivityComparisonRow } from "dofek-server/types";
import {
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  seriesColor,
} from "../lib/chartTheme.ts";
import { formatPace } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ActivityComparisonChartProps {
  data: ActivityComparisonRow[];
  loading?: boolean;
}

export function ActivityComparisonChart({ data, loading }: ActivityComparisonChartProps) {
  const units = useUnitConverter();

  const series = data.map((route, index) => ({
    ...dofekSeries.line(
      route.activityName,
      route.instances.map((instance) => [
        instance.date,
        units.convertPace(instance.averagePaceMinPerKm * 60),
      ]),
      {
        color: seriesColor(index),
        smooth: false,
        symbol: "circle",
        symbolSize: 8,
      },
    ),
    connectNulls: true,
  }));

  const option = {
    grid: dofekGrid("single", { top: 40, left: 65 }),
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: Record<string, unknown>) => {
        const rawValue = Array.isArray(params.value) ? params.value : ["", 0];
        const date = String(rawValue[0] ?? "");
        const pace = typeof rawValue[1] === "number" ? rawValue[1] : 0;
        const seriesName = String(params.seriesName ?? "");
        return [
          `<strong>${seriesName}</strong>`,
          `Date: ${date}`,
          `Pace: ${formatPace(pace)} ${units.paceLabel}`,
        ].join("<br/>");
      },
    }),
    legend: dofekLegend(true, { type: "scroll" }),
    xAxis: dofekAxis.time(),
    yAxis: {
      ...dofekAxis.value({ name: `Pace (min${units.paceLabel})` }),
      inverse: true,
      axisLabel: {
        ...dofekAxis.value().axisLabel,
        formatter: (value: number) => formatPace(value),
      },
    },
    series,
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Repeated Route Comparison (lower = faster)
      </h3>
      <DofekChart
        option={option}
        loading={loading}
        empty={data.length === 0}
        height={280}
        emptyMessage="No repeated routes found (need 2+ instances with the same name)"
      />
      <p className="text-xs text-dim mt-1">
        Each line tracks pace over time for a repeated route. Y-axis is inverted so lower (faster)
        pace appears higher.
      </p>
    </div>
  );
}
