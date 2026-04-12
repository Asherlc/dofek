import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface PowerCurvePoint {
  durationSeconds: number;
  label: string;
  bestPower: number;
  activityDate: string;
}

interface CriticalPowerModel {
  cp: number;
  wPrime: number;
  r2: number;
}

interface PowerCurveChartProps {
  data: PowerCurvePoint[];
  comparisonData?: PowerCurvePoint[];
  model?: CriticalPowerModel | null;
  loading?: boolean;
  error?: boolean;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

export function PowerCurveChart({
  data,
  comparisonData,
  model,
  loading,
  error,
}: PowerCurveChartProps) {
  // Generate CP model curve points (smooth line from 120s to 7200s)
  const modelCurveData: [number, number][] = [];
  if (model && model.cp > 0) {
    const logMin = Math.log10(120);
    const logMax = Math.log10(7200);
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const timeSeconds = 10 ** (logMin + (logMax - logMin) * (i / steps));
      const powerWatts = model.cp + model.wPrime / timeSeconds;
      modelCurveData.push([Math.round(timeSeconds), Math.round(powerWatts)]);
    }
  }

  const series = [
    dofekSeries.line(
      "Best Power",
      data.map((d) => [d.durationSeconds, d.bestPower]),
      {
        color: chartColors.purple,
        smooth: 0.3,
        width: 3,
        symbol: "circle",
        symbolSize: 6,
        areaStyle: { opacity: 0.1, color: chartColors.purple },
      },
    ),
  ];

  if (modelCurveData.length > 0 && model) {
    series.push(
      dofekSeries.line(
        `Threshold Model (${model.cp}W, reserve=${Math.round(model.wPrime / 1000)}kJ)`,
        modelCurveData,
        {
          color: chartColors.orange,
          lineStyle: { type: "dashed" },
        },
      ),
    );
  }

  if (comparisonData && comparisonData.length > 0) {
    series.push(
      dofekSeries.line(
        "Previous Period",
        comparisonData.map((d) => [d.durationSeconds, d.bestPower]),
        {
          color: chartThemeColors.axisLabel,
          smooth: 0.3,
          symbol: "circle",
          symbolSize: 4,
        },
      ),
    );
  }

  const option = {
    grid: dofekGrid("single", { top: 30, bottom: 40, left: 55 }),
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { data: [number, number]; seriesName: string }) => {
        const [seconds, watts] = params.data;
        return `${params.seriesName}<br/>${formatDuration(seconds)}: <strong>${watts}W</strong>`;
      },
    }),
    xAxis: {
      type: "log" as const,
      name: "Duration",
      nameLocation: "center" as const,
      nameGap: 25,
      nameTextStyle: { color: chartThemeColors.axisLabel, fontSize: 11 },
      min: 5,
      max: 7200,
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 11,
        formatter: (value: number) => formatDuration(value),
      },
      axisLine: { lineStyle: { color: chartThemeColors.axisLine } },
      splitLine: { show: false },
    },
    yAxis: dofekAxis.value({ name: "Watts" }),
    legend: dofekLegend(series.length > 1),
    series,
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      error={error}
      empty={data.length === 0}
      height={280}
      emptyMessage="No power data"
    />
  );
}
