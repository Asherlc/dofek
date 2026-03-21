import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";
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

interface AdaptiveTdeeChartProps {
  data: AdaptiveTdeeResult | undefined;
  loading?: boolean;
}

export function AdaptiveTdeeChart({ data, loading }: AdaptiveTdeeChartProps) {
  const { unitSystem } = useUnitSystem();

  if (!data || data.dailyData.length === 0) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need calorie tracking + weight measurements for TDEE estimation"
      />
    );
  }

  const tdeePoints = data.dailyData.filter((d) => d.estimatedTdee != null);

  const weightValues = data.dailyData
    .filter((d) => d.smoothedWeight != null)
    .map((d) => Number(d.smoothedWeight));
  const weightMin = Math.min(...weightValues);
  const weightMax = Math.max(...weightValues);
  const weightPadding = Math.max((weightMax - weightMin) * 0.3, 1);
  const weightAxisMin = Math.floor(weightMin - weightPadding);
  const weightAxisMax = Math.ceil(weightMax + weightPadding);

  const option = {
    grid: dofekGrid("dualAxis"),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({ name: "kcal" }),
      dofekAxis.value({
        name: weightLabel(unitSystem),
        position: "right",
        min: weightValues.length > 0 ? weightAxisMin : undefined,
        max: weightValues.length > 0 ? weightAxisMax : undefined,
        showSplitLine: false,
      }),
    ],
    series: [
      dofekSeries.line(
        "Calories In",
        data.dailyData.filter((d) => d.caloriesIn > 0).map((d) => [d.date, d.caloriesIn]),
        { color: chartColors.blue, width: 1, lineStyle: { opacity: 0.5 } },
      ),
      dofekSeries.line(
        "Estimated TDEE",
        tdeePoints.map((d) => [d.date, d.estimatedTdee]),
        { color: chartColors.amber, width: 3 },
      ),
      dofekSeries.line(
        "Smoothed Weight",
        data.dailyData
          .filter((d) => d.smoothedWeight != null)
          .map((d) => [
            d.date,
            d.smoothedWeight != null ? convertWeight(d.smoothedWeight, unitSystem) : null,
          ]),
        { color: chartColors.teal, yAxisIndex: 1 },
      ),
    ],
  };

  return (
    <div className="space-y-3">
      {/* Summary stat */}
      {data.estimatedTdee != null && (
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold text-foreground">{data.estimatedTdee}</span>
          <span className="text-sm text-muted">kcal/day estimated TDEE</span>
          <span className="text-xs text-dim">
            ({Math.round(data.confidence * 100)}% confidence, {data.dataPoints} data points)
          </span>
        </div>
      )}

      <DofekChart option={option} loading={loading} />
    </div>
  );
}
