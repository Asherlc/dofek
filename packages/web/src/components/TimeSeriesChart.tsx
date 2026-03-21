import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface Series {
  name: string;
  data: [string, number | null][];
  color?: string;
  areaStyle?: boolean;
  yAxisIndex?: number;
}

interface TimeSeriesChartProps {
  series: Series[];
  height?: number;
  yAxis?: { name?: string; min?: number | "dataMin"; max?: number | "dataMax" }[];
  loading?: boolean;
}

export function TimeSeriesChart({ series, height = 200, yAxis, loading }: TimeSeriesChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  const yAxisConfig = (yAxis ?? [{}]).map((axis, i) => ({
    type: "value" as const,
    name: axis.name,
    min: axis.min,
    max: axis.max,
    splitLine: i === 0 ? { lineStyle: { color: "rgba(74, 158, 122, 0.12)" } } : { show: false },
    axisLabel: { color: "#6b8a6b", fontSize: 11 },
    axisLine: { show: true, lineStyle: { color: "rgba(74, 158, 122, 0.25)" } },
    nameTextStyle: { color: "#6b8a6b", fontSize: 11 },
    position: i === 0 ? ("left" as const) : ("right" as const),
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: yAxisConfig.length > 1 ? 50 : 12, bottom: 30, left: 40 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#ffffff",
      borderColor: "rgba(74, 158, 122, 0.2)",
      textStyle: { color: "#1a2e1a", fontSize: 12 },
    },
    xAxis: {
      type: "time",
      axisLabel: { color: "#6b8a6b", fontSize: 11 },
      axisLine: { lineStyle: { color: "rgba(74, 158, 122, 0.25)" } },
      splitLine: { show: false },
    },
    yAxis: yAxisConfig,
    series: series.map((s) => ({
      name: s.name,
      type: "line",
      data: s.data.filter(([, v]) => v != null),
      smooth: true,
      symbol: "none",
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: s.areaStyle ? { opacity: 0.15 } : undefined,
      yAxisIndex: s.yAxisIndex ?? 0,
    })),
    legend: {
      show: series.length > 1,
      textStyle: { color: "#4a6a4a", fontSize: 11 },
      top: 0,
    },
  };

  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge={true} />;
}
