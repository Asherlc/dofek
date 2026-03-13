import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

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
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

export function PowerCurveChart({ data, comparisonData, model, loading }: PowerCurveChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={280} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">No power data</span>
      </div>
    );
  }

  // Generate CP model curve points (smooth line from 120s to 7200s)
  const modelCurveData: [number, number][] = [];
  if (model && model.cp > 0) {
    const logMin = Math.log10(120);
    const logMax = Math.log10(7200);
    const steps = 50;
    for (let i = 0; i <= steps; i++) {
      const t = 10 ** (logMin + (logMax - logMin) * (i / steps));
      const p = model.cp + model.wPrime / t;
      modelCurveData.push([Math.round(t), Math.round(p)]);
    }
  }

  interface SeriesItem {
    name: string;
    type: "line";
    data: [number, number][];
    smooth: number | boolean;
    symbol: string;
    symbolSize: number;
    lineStyle: { width: number; color: string; type?: "dashed" | "solid" };
    itemStyle: { color: string };
    areaStyle?: { opacity: number; color: string };
  }

  const series: SeriesItem[] = [
    {
      name: "Best Power",
      type: "line",
      data: data.map((d) => [d.durationSeconds, d.bestPower]),
      smooth: 0.3,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { width: 3, color: "#8b5cf6" },
      itemStyle: { color: "#8b5cf6" },
      areaStyle: { opacity: 0.1, color: "#8b5cf6" },
    },
  ];

  if (modelCurveData.length > 0 && model) {
    series.push({
      name: `Threshold Model (${model.cp}W, reserve=${Math.round(model.wPrime / 1000)}kJ)`,
      type: "line",
      data: modelCurveData,
      smooth: true,
      symbol: "none",
      symbolSize: 0,
      lineStyle: { width: 2, color: "#f97316", type: "dashed" },
      itemStyle: { color: "#f97316" },
    });
  }

  if (comparisonData && comparisonData.length > 0) {
    series.push({
      name: "Previous Period",
      type: "line",
      data: comparisonData.map((d) => [d.durationSeconds, d.bestPower]),
      smooth: 0.3,
      symbol: "circle",
      symbolSize: 4,
      lineStyle: { width: 2, color: "#71717a" },
      itemStyle: { color: "#71717a" },
    });
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 55 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: { data: [number, number]; seriesName: string }) => {
        const [seconds, watts] = params.data;
        return `${params.seriesName}<br/>${formatDuration(seconds)}: <strong>${watts}W</strong>`;
      },
    },
    xAxis: {
      type: "log" as const,
      name: "Duration",
      nameLocation: "center" as const,
      nameGap: 25,
      nameTextStyle: { color: "#71717a", fontSize: 11 },
      min: 5,
      max: 7200,
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (value: number) => formatDuration(value),
      },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: "Watts",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      show: series.length > 1,
      textStyle: { color: "#a1a1aa", fontSize: 10 },
      top: 0,
    },
    series,
  };

  return <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />;
}
