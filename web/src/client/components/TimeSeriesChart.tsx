import ReactECharts from "echarts-for-react";

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
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  const yAxisConfig = (yAxis ?? [{}]).map((axis, i) => ({
    type: "value" as const,
    name: axis.name,
    min: axis.min,
    max: axis.max,
    splitLine: i === 0 ? { lineStyle: { color: "#27272a" } } : { show: false },
    axisLabel: { color: "#71717a", fontSize: 11 },
    axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
    nameTextStyle: { color: "#71717a", fontSize: 11 },
    position: i === 0 ? ("left" as const) : ("right" as const),
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: yAxisConfig.length > 1 ? 60 : 20, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
    },
    xAxis: {
      type: "time",
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
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
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
  };

  return <ReactECharts option={option} style={{ height }} notMerge={true} />;
}
