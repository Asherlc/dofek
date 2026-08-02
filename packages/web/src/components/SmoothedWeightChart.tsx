import { formatDateLong } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { textColors } from "@dofek/scoring/colors";
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
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SmoothedWeightChartProps {
  data: SmoothedWeightRow[];
  prediction?: WeightPrediction | null;
  loading?: boolean;
}

function roundWeight(value: number): number {
  return Math.round(value * 10) / 10;
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

  const ratePerWeekKg = prediction?.ratePerWeek ?? null;
  const latest = data.at(-1);
  let latestScaleWeight: number | null = null;
  let latestScaleWeightStatus: string | null = null;
  for (let index = data.length - 1; index >= 0; index--) {
    const row = data[index];
    if (!row) continue;
    const rawWeight = row?.rawWeight;
    if (rawWeight != null) {
      latestScaleWeight = rawWeight;
      latestScaleWeightStatus = row.rawWeightStatus?.label ?? null;
      break;
    }
  }
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
                formatter: `Goal: ${formatMeasurementText(units.formatWeight(goalWeightKg))}`,
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
        .map((d) => [d.date, roundWeight(units.convertWeight(d.rawWeight))]),
      {
        color: chartThemeColors.axisLabel,
        symbolSize: 4,
        itemStyle: { opacity: 0.5 },
      },
    ),
    // Smoothed trend line with optional goal markLine/markArea
    {
      ...dofekSeries.line(
        "Trend Weight",
        data.map((d) => [d.date, roundWeight(units.convertWeight(d.smoothedWeight))]),
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
          .map((d) => [d.date, roundWeight(units.convertWeight(d.weeklyChange ?? 0))]),
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
      projectionData.push([
        lastDataPoint.date,
        roundWeight(units.convertWeight(lastDataPoint.smoothedWeight)),
      ]);
    }
    for (const point of prediction.projectionLine) {
      projectionData.push([point.date, roundWeight(units.convertWeight(point.projectedWeight))]);
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
    tooltip: dofekTooltip({
      formatter(
        params: Array<{
          seriesName: string;
          value: [string, number];
          marker: string;
        }>,
      ) {
        const first = params[0];
        if (!first) return "";
        const lines = [`<strong>${escapeTooltipHtml(formatDateLong(first.value[0]))}</strong>`];
        for (const param of params) {
          const value = param.value[1];
          const unit =
            param.seriesName === "Weekly Change" ? `${units.weightLabel}/week` : units.weightLabel;
          lines.push(
            `${param.marker} ${escapeTooltipHtml(param.seriesName)}: ${value} ${escapeTooltipHtml(unit)}`,
          );
        }
        return lines.join("<br/>");
      },
    }),
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
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-subtle">
            {latest?.smoothedWeightStatus.label} Trend Weight
          </div>
          <div className="text-lg font-semibold font-mono tabular-nums">
            {latest ? formatMeasurementText(units.formatWeight(latest.smoothedWeight)) : "—"}
          </div>
          {latestScaleWeight != null && latestScaleWeightStatus != null && (
            <div className="text-xs text-subtle">
              {latestScaleWeightStatus}:{" "}
              {formatMeasurementText(units.formatWeight(latestScaleWeight))}
            </div>
          )}
        </div>
        {ratePerWeekKg != null && (
          <span className="text-lg font-semibold" style={{ color: textColors.secondary }}>
            {ratePerWeekKg > 0 ? "+" : ""}
            {formatMeasurementText(units.formatWeight(ratePerWeekKg))}
            /week
          </span>
        )}
      </div>
      <DofekChart option={option} height={250} />
    </div>
  );
}
