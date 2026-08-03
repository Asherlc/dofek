import type { AdaptiveTdeeResult } from "../../../server/src/routers/nutrition-analytics.ts";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface AdaptiveTdeeChartProps {
  data: AdaptiveTdeeResult | undefined;
  loading?: boolean;
}

export function AdaptiveTdeeChart({ data, loading }: AdaptiveTdeeChartProps) {
  const units = useUnitConverter();

  if (!data) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={true}
        emptyMessage="Need calorie tracking and weight measurements to estimate Total Daily Energy Expenditure (TDEE)"
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
      dofekAxis.value({ name: units.calorieLabel }),
      dofekAxis.value({
        name: units.weightLabel,
        position: "right",
        min: weightValues.length > 0 ? weightAxisMin : undefined,
        max: weightValues.length > 0 ? weightAxisMax : undefined,
        showSplitLine: false,
      }),
    ],
    series: [
      dofekSeries.line(
        "Calories In",
        data.dailyData
          .filter((d) => d.caloriesIn != null && d.caloriesIn > 0)
          .map((d) => [d.date, d.caloriesIn]),
        { color: chartColors.blue, width: 1, lineStyle: { opacity: 0.5 } },
      ),
      dofekSeries.line(
        "Estimated Total Daily Energy Expenditure (TDEE)",
        tdeePoints.map((d) => [d.date, d.estimatedTdee]),
        { color: chartColors.amber, width: 3 },
      ),
      dofekSeries.line(
        "Smoothed Weight",
        data.dailyData
          .filter((d) => d.smoothedWeight != null)
          .map((d) => [
            d.date,
            d.smoothedWeight != null ? units.convertWeight(d.smoothedWeight) : null,
          ]),
        { color: chartColors.teal, yAxisIndex: 1 },
      ),
    ],
  };

  return (
    <div className="space-y-3">
      {/* Summary stat */}
      {data.estimatedTdee != null && (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-foreground">{data.estimatedTdee}</span>
            <span className="text-sm text-muted">
              {units.caloriesPerDayLabel} estimated total daily energy expenditure (TDEE)
            </span>
          </div>
          {data.estimateRange && (
            <p className="text-xs text-muted">
              Observed rolling range: {data.estimateRange.minimum}–{data.estimateRange.maximum}{" "}
              {units.caloriesPerDayLabel}
            </p>
          )}
        </>
      )}

      {data.status === "unavailable" && data.unavailableReason && (
        <p className="text-sm text-muted">{data.unavailableReason}</p>
      )}

      <AdaptiveTdeeEvidence data={data} />

      {data.dailyData.length > 0 && <DofekChart option={option} loading={loading} />}
    </div>
  );
}

function AdaptiveTdeeEvidence({ data }: { data: AdaptiveTdeeResult }) {
  const evidence = data.evidence;
  const exclusions = evidence.excludedDays;
  return (
    <div className="space-y-1 text-xs text-dim">
      <p>
        {evidence.selectedWindowDays}-day evaluation · {evidence.observedDays} accessible calendar
        days
      </p>
      <p>
        {evidence.fitWindowDays}-day fit · at least {evidence.minimumCalorieDays} usable calorie
        days
      </p>
      <p>
        {evidence.calorieDays} calorie days · {evidence.weightDays} weight days ·{" "}
        {evidence.acceptedWindows} accepted windows
      </p>
      {(exclusions.missingCalories > 0 ||
        exclusions.sourceConflict > 0 ||
        exclusions.lowerPrioritySources > 0) && (
        <p>
          Excluded: {exclusions.missingCalories} missing calorie days · {exclusions.sourceConflict}{" "}
          source-conflict days · {exclusions.lowerPrioritySources} days with lower-priority sources
        </p>
      )}
    </div>
  );
}
