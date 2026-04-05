import type {
  SmoothedWeightRow,
  WeightPrediction,
} from "../../../server/src/routers/body-analytics.ts";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SmoothedWeightChartProps {
  data: SmoothedWeightRow[];
  prediction?: WeightPrediction | null;
  loading?: boolean;
}

export function SmoothedWeightChart({ data, prediction, loading }: SmoothedWeightChartProps) {
  const units = useUnitConverter();

  if (loading) {
    return <DofekChart option={{}} loading={true} height={250} />;
  }

  if (data.length === 0) {
    return (
      <DofekChart option={{}} empty={true} height={250} emptyMessage="No weight data available" />
    );
  }

  const latestWeeklyChange = data[data.length - 1]?.weeklyChange;
  const goalWeightKg = prediction?.goal?.goalWeightKg ?? null;
  const goalBandKg = 1.1; // ±1.1 kg band around goal

  // Build goal markLine + markArea for the trend series
  const goalMarkLine =
    goalWeightKg != null
      ? {
          silent: true,
          symbol: "none",
          data: [
            {
              yAxis: units.convertWeight(goalWeightKg),
              label: {
                formatter: `Goal: ${formatNumber(units.convertWeight(goalWeightKg))}`,
                position: "insideEndTop" as const,
              },
              lineStyle: { type: "dashed" as const, color: chartColors.green, width: 2 },
            },
          ],
        }
      : undefined;

  const goalMarkArea =
    goalWeightKg != null
      ? {
          silent: true,
          data: [
            [
              { yAxis: units.convertWeight(goalWeightKg - goalBandKg) },
              { yAxis: units.convertWeight(goalWeightKg + goalBandKg) },
            ],
          ],
          itemStyle: { color: "rgba(34,197,94,0.08)" },
        }
      : undefined;

  const series = [
    // Raw weight scatter: only non-interpolated points
    dofekSeries.scatter(
      "Raw Weight",
      data
        .filter(
          (d): d is typeof d & { rawWeight: number } => !d.interpolated && d.rawWeight != null,
        )
        .map((d) => [d.date, units.convertWeight(d.rawWeight)]),
      {
        color: chartThemeColors.axisLabel,
        symbolSize: 4,
        itemStyle: { opacity: 0.5 },
      },
    ),
    // Smoothed trend line with optional goal markLine/markArea
    {
      ...dofekSeries.line(
        "Trend",
        data.map((d) => [d.date, units.convertWeight(d.smoothedWeight)]),
        {
          color: chartColors.teal,
          width: 3,
        },
      ),
      ...(goalMarkLine ? { markLine: goalMarkLine } : {}),
      ...(goalMarkArea ? { markArea: goalMarkArea } : {}),
    },
    // Weekly change bars
    {
      ...dofekSeries.bar(
        "Weekly Change",
        data
          .filter((d) => d.weeklyChange != null)
          .map((d) => [d.date, units.convertWeight(d.weeklyChange ?? 0)]),
        { yAxisIndex: 1, barWidth: "60%" },
      ),
      itemStyle: {
        color: (params: { value: [string, number] }) =>
          params.value[1] >= 0 ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
      },
    },
  ];

  // Projection line (dashed, extends from last data point into the future)
  if (prediction?.projectionLine && prediction.projectionLine.length > 0) {
    const lastDataPoint = data[data.length - 1];
    const projectionData: [string, number][] = [];
    // Start from last actual point for visual continuity
    if (lastDataPoint) {
      projectionData.push([lastDataPoint.date, units.convertWeight(lastDataPoint.smoothedWeight)]);
    }
    for (const point of prediction.projectionLine) {
      projectionData.push([point.date, units.convertWeight(point.projectedWeight)]);
    }

    const projectionSeries = dofekSeries.line("Projection", projectionData, {
      color: chartColors.teal,
      width: 2,
    });
    // Override lineStyle for dashed projection
    Object.assign(projectionSeries, {
      lineStyle: { ...projectionSeries.lineStyle, type: "dashed", opacity: 0.5 },
    });
    series.push(projectionSeries);
  }

  const option = {
    grid: dofekGrid("dualAxis", { top: 30, bottom: 30 }),
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({
        name: units.weightLabel,
        min: (value: { min: number }) => Math.floor(value.min / 2) * 2,
      }),
      dofekAxis.value({
        name: `${units.weightLabel}/week`,
        position: "right",
        showSplitLine: false,
      }),
    ],
    series,
  };

  return (
    <div className="space-y-2">
      {latestWeeklyChange != null && (
        <div className="flex items-baseline gap-2">
          <span
            className={`text-lg font-semibold ${latestWeeklyChange > 0 ? "text-green-400" : latestWeeklyChange < 0 ? "text-red-400" : "text-muted"}`}
          >
            {latestWeeklyChange > 0 ? "+" : ""}
            {formatNumber(units.convertWeight(latestWeeklyChange))} {units.weightLabel}
            /week
          </span>
        </div>
      )}
      <DofekChart option={option} height={250} />
    </div>
  );
}
