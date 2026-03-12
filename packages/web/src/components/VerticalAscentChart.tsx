import ReactECharts from "echarts-for-react";

export interface VerticalAscentDataPoint {
  date: string;
  activityName: string;
  verticalAscentRate: number;
  elevationGainMeters: number;
}

export interface VerticalAscentChartProps {
  data: VerticalAscentDataPoint[];
  loading?: boolean;
}

export function VerticalAscentChart({ data, loading }: VerticalAscentChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading vertical ascent data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No activities with altitude data available</span>
      </div>
    );
  }

  // Scale bubble size by elevation gain
  const maxGain = Math.max(...data.map((d) => d.elevationGainMeters));
  const minSize = 8;
  const maxSize = 40;

  const scatterData = data.map((d) => ({
    value: [d.date, d.verticalAscentRate],
    name: d.activityName,
    elevationGain: d.elevationGainMeters,
    symbolSize:
      maxGain > 0 ? minSize + (d.elevationGainMeters / maxGain) * (maxSize - minSize) : minSize,
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>) => {
        const itemData = params.data as
          | {
              value: [string, number];
              name: string;
              elevationGain: number;
            }
          | undefined;
        if (!itemData?.name) return "";
        const [date, vam] = itemData.value;
        return [
          `<strong>${itemData.name}</strong>`,
          `Date: ${new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
          `VAM: ${vam.toFixed(0)} m/h`,
          `Elevation Gain: ${itemData.elevationGain.toFixed(0)} m`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      name: "VAM (m/h)",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        name: "Vertical Ascent Rate",
        type: "scatter",
        data: scatterData.map((d) => ({
          value: d.value,
          name: d.name,
          elevationGain: d.elevationGain,
          symbolSize: d.symbolSize,
        })),
        symbolSize: (_val: unknown, params: Record<string, unknown>) => {
          const itemData = params.data as { symbolSize: number } | undefined;
          return itemData?.symbolSize ?? minSize;
        },
        itemStyle: {
          color: "#8b5cf6",
          opacity: 0.7,
        },
      },
    ],
  };

  return (
    <div>
      <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />
      <p className="text-xs text-zinc-600 mt-1">
        Bubble size indicates elevation gain. Higher VAM = stronger climbing performance.
      </p>
    </div>
  );
}
