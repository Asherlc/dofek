import ReactECharts from "echarts-for-react";

export interface ElevationGainChartRow {
  week: string;
  elevationGainMeters: number;
  activityCount: number;
  totalDistanceKm: number;
}

interface ElevationGainChartProps {
  data: ElevationGainChartRow[];
  loading?: boolean;
}

export function ElevationGainChart({ data, loading }: ElevationGainChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">Loading elevation data...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No elevation data available</span>
      </div>
    );
  }

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 20, bottom: 30, left: 55 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Record<string, unknown>[]) => {
        const param = params[0] as {
          name: string;
          value: number;
          dataIndex: number;
        };
        const row = data[param.dataIndex];
        if (!row) return "";
        return [
          `<strong>Week of ${row.week}</strong>`,
          `Elevation Gain: ${row.elevationGainMeters.toFixed(0)} m`,
          `Activities: ${row.activityCount}`,
          `Distance: ${row.totalDistanceKm.toFixed(1)} km`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: data.map((d) => d.week),
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: "Elevation Gain (m)",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: data.map((d) => d.elevationGainMeters),
        itemStyle: { color: "#f59e0b" },
        barMaxWidth: 30,
      },
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Weekly Elevation Gain (Hiking & Walking)
      </h3>
      <ReactECharts option={option} style={{ height: 280 }} notMerge={true} />
    </div>
  );
}
