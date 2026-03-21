import type { SmoothedWeightRow } from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import { convertWeight, weightLabel } from "../lib/units.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SmoothedWeightChartProps {
  data: SmoothedWeightRow[];
  loading?: boolean;
}

export function SmoothedWeightChart({ data, loading }: SmoothedWeightChartProps) {
  const { unitSystem } = useUnitSystem();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={250} />;
  }

  if (data.length === 0) {
    return (
      <DofekChart option={{}} empty={true} height={250} emptyMessage="No weight data available" />
    );
  }

  const latestWeeklyChange = data[data.length - 1]?.weeklyChange;

  const option = {
    grid: dofekGrid("dualAxis", { top: 30, bottom: 30 }),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({ name: weightLabel(unitSystem), min: "dataMin" }),
      dofekAxis.value({
        name: `${weightLabel(unitSystem)}/week`,
        position: "right",
        showSplitLine: false,
      }),
    ],
    series: [
      dofekSeries.scatter(
        "Raw Weight",
        data.map((d) => [d.date, convertWeight(d.rawWeight, unitSystem)]),
        {
          color: "#6b8a6b",
          symbolSize: 4,
          itemStyle: { opacity: 0.5 },
        },
      ),
      {
        ...dofekSeries.line(
          "Trend",
          data.map((d) => [d.date, convertWeight(d.smoothedWeight, unitSystem)]),
          {
            color: chartColors.teal,
            width: 3,
          },
        ),
      },
      {
        ...dofekSeries.bar(
          "Weekly Change",
          data
            .filter((d) => d.weeklyChange != null)
            .map((d) => [d.date, convertWeight(d.weeklyChange ?? 0, unitSystem)]),
          { yAxisIndex: 1, barWidth: "60%" },
        ),
        itemStyle: {
          color: (params: { value: [string, number] }) =>
            params.value[1] >= 0 ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
        },
      },
    ],
  };

  return (
    <div className="space-y-2">
      {latestWeeklyChange != null && (
        <div className="flex items-baseline gap-2">
          <span
            className={`text-lg font-semibold ${latestWeeklyChange > 0 ? "text-green-400" : latestWeeklyChange < 0 ? "text-red-400" : "text-muted"}`}
          >
            {latestWeeklyChange > 0 ? "+" : ""}
            {convertWeight(latestWeeklyChange, unitSystem).toFixed(1)} {weightLabel(unitSystem)}
            /week
          </span>
        </div>
      )}
      <DofekChart option={option} height={250} />
    </div>
  );
}
