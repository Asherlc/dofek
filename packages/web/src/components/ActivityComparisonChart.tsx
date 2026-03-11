import ReactECharts from "echarts-for-react";

export interface ActivityComparisonInstance {
  date: string;
  averagePaceMinPerKm: number;
}

export interface ActivityComparisonData {
  activityName: string;
  instances: ActivityComparisonInstance[];
}

interface ActivityComparisonChartProps {
  data: ActivityComparisonData[];
  loading?: boolean;
}

const SERIES_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function formatPace(minPerKm: number): string {
  const totalSeconds = Math.round(minPerKm * 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ActivityComparisonChart({ data, loading }: ActivityComparisonChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading activity comparison data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">
          No repeated routes found (need 2+ instances with the same name)
        </span>
      </div>
    );
  }

  const series = data.map((route, index) => ({
    name: route.activityName,
    type: "line" as const,
    data: route.instances.map((instance) => [instance.date, instance.averagePaceMinPerKm]),
    symbol: "circle",
    symbolSize: 8,
    lineStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length], width: 2 },
    itemStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length] },
    connectNulls: true,
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 65 },
    tooltip: {
      trigger: "item",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>) => {
        const value = params.value as [string, number];
        const seriesName = params.seriesName as string;
        return [
          `<strong>${seriesName}</strong>`,
          `Date: ${value[0]}`,
          `Pace: ${formatPace(value[1])}/km`,
        ].join("<br/>");
      },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
      type: "scroll",
    },
    xAxis: {
      type: "time",
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "Pace (min/km)",
      inverse: true,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: {
        color: "#71717a",
        fontSize: 11,
        formatter: (value: number) => formatPace(value),
      },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series,
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Repeated Route Comparison (lower = faster)
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Each line tracks pace over time for a repeated route. Y-axis is inverted so lower (faster)
        pace appears higher.
      </p>
    </div>
  );
}
