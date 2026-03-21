import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface BodyRecompositionChartProps {
  data: BodyRecompositionRow[];
  loading?: boolean;
}

export function BodyRecompositionChart({ data, loading }: BodyRecompositionChartProps) {
  const units = useUnitConverter();

  if (data.length === 0) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need weight + body fat data for recomposition tracking"
      />
    );
  }

  // Compute change from first to last
  const first = data[0];
  const last = data[data.length - 1];
  if (!first || !last) {
    return null;
  }
  const fatChange = last.smoothedFatMass - first.smoothedFatMass;
  const leanChange = last.smoothedLeanMass - first.smoothedLeanMass;

  const option = {
    grid: dofekGrid("single", { left: 50 }),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: units.weightLabel }),
    series: [
      dofekSeries.line(
        "Fat Mass (smoothed)",
        data.map((d) => [d.date, units.convertWeight(d.smoothedFatMass)]),
        { color: chartColors.orange, areaStyle: { opacity: 0.1 } },
      ),
      dofekSeries.line(
        "Lean Mass (smoothed)",
        data.map((d) => [d.date, units.convertWeight(d.smoothedLeanMass)]),
        { color: chartColors.blue, areaStyle: { opacity: 0.1 } },
      ),
    ],
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-sm">
        <span className={`font-medium ${fatChange <= 0 ? "text-green-400" : "text-red-400"}`}>
          Fat: {fatChange > 0 ? "+" : ""}
          {formatNumber(units.convertWeight(fatChange))} {units.weightLabel}
        </span>
        <span className={`font-medium ${leanChange >= 0 ? "text-green-400" : "text-red-400"}`}>
          Lean: {leanChange > 0 ? "+" : ""}
          {formatNumber(units.convertWeight(leanChange))} {units.weightLabel}
        </span>
      </div>
      <DofekChart option={option} loading={loading} />
    </div>
  );
}
